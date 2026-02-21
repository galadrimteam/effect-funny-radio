package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const openaiURL = "wss://api.openai.com/v1/realtime?model=gpt-realtime-mini"

// OpenAIRealtime manages the WebSocket connection to OpenAI's Realtime API.
type OpenAIRealtime struct {
	conn        *websocket.Conn
	broadcaster *Broadcaster
	writeCh     chan []byte // async write queue — decouples processor from socket I/O
	done        chan struct{}
	writeDone   chan struct{}

	// Response timing tracking
	timingMu        sync.Mutex
	lastRequestedAt time.Time            // when RequestResponse() was last called
	firstDeltaAt    map[string]time.Time // responseId → time of first delta
}

// NewOpenAIRealtime connects to the OpenAI Realtime API with retry logic and
// starts a background goroutine to read incoming messages.
func NewOpenAIRealtime(ctx context.Context, apiKey string, broadcaster *Broadcaster) (*OpenAIRealtime, error) {
	log.Println("Connecting to OpenAI Realtime API...")

	var conn *websocket.Conn
	var err error

	header := http.Header{}
	header.Set("Authorization", "Bearer "+apiKey)

	// Retry with exponential backoff, max 5 attempts
	backoff := time.Second
	for attempt := 0; attempt < 5; attempt++ {
		dialer := websocket.Dialer{}
		conn, _, err = dialer.DialContext(ctx, openaiURL, header)
		if err == nil {
			break
		}
		log.Printf("WebSocket connection failed (attempt %d/5), retrying in %v: %v", attempt+1, backoff, err)
		select {
		case <-time.After(backoff):
			backoff *= 2
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if err != nil {
		return nil, fmt.Errorf("failed to connect to OpenAI after 5 attempts: %w", err)
	}

	// Send session configuration
	sessionUpdate := map[string]any{
		"type": "session.update",
		"session": map[string]any{
			"type": "realtime",
			"audio": map[string]any{
				"input": map[string]any{
					"format":          map[string]any{"type": "audio/pcm", "rate": 24000},
					"turn_detection":  nil,
					"noise_reduction": nil,
				},
			},
			"instructions":      systemInstruction,
			"model":             "gpt-realtime-mini",
			"output_modalities": []string{"text"},
			"tracing":           "auto",
		},
	}

	if err := conn.WriteJSON(sessionUpdate); err != nil {
		conn.Close()
		return nil, fmt.Errorf("failed to send session update: %w", err)
	}

	log.Println("Connected to OpenAI Realtime API")

	rt := &OpenAIRealtime{
		conn:         conn,
		broadcaster:  broadcaster,
		writeCh:      make(chan []byte, 256),
		done:         make(chan struct{}),
		writeDone:    make(chan struct{}),
		firstDeltaAt: make(map[string]time.Time),
	}

	// Start read and write loops
	go rt.readLoop()
	go rt.writeLoop()

	return rt, nil
}

func (rt *OpenAIRealtime) readLoop() {
	defer close(rt.done)

	for {
		_, message, err := rt.conn.ReadMessage()
		if err != nil {
			if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				log.Println("OpenAI WebSocket closed normally")
			} else {
				log.Printf("OpenAI WebSocket read error: %v", err)
			}
			return
		}

		var event ServerEvent
		if err := json.Unmarshal(message, &event); err != nil {
			log.Printf("Failed to parse OpenAI WebSocket message: %v", err)
			continue
		}

		switch event.Type {
		case "response.output_text.delta":
			rt.trackFirstDelta(event.ResponseID)
			rt.broadcaster.Publish(BroadcastMessage{
				Type:       "delta",
				ResponseID: event.ResponseID,
				Text:       event.Delta,
			})
		case "response.done":
			if event.Response != nil {
				rt.trackResponseDone(event.Response.ID)
				rt.broadcaster.Publish(BroadcastMessage{
					Type:       "complete",
					ResponseID: event.Response.ID,
				})
			}
		case "error":
			if event.Error != nil {
				log.Printf("OpenAI error: %s", event.Error.Message)
				rt.broadcaster.Publish(BroadcastMessage{
					Type:    "error",
					Message: event.Error.Message,
				})
			}
		}
	}
}

// writeLoop drains the write channel and sends messages to the WebSocket.
// This decouples the audio processor from socket I/O latency.
func (rt *OpenAIRealtime) writeLoop() {
	defer close(rt.writeDone)
	for msg := range rt.writeCh {
		if err := rt.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			log.Printf("OpenAI WebSocket write error: %v", err)
			return
		}
	}
}

// Pre-serialized JSON fragments to avoid map allocation + json.Marshal per chunk.
var (
	appendAudioPrefix = []byte(`{"type":"input_audio_buffer.append","audio":"`)
	appendAudioSuffix = []byte(`"}`)
	commitBufferMsg   = []byte(`{"type":"input_audio_buffer.commit"}`)
	responseCreateMsg = []byte(`{"type":"response.create"}`)
)

// appendBuf is reused across AppendAudio calls to avoid allocations.
// Safe because only the audio processor goroutine calls AppendAudio.
var appendBuf []byte

func (rt *OpenAIRealtime) AppendAudio(base64Audio string) {
	needed := len(appendAudioPrefix) + len(base64Audio) + len(appendAudioSuffix)
	if cap(appendBuf) < needed {
		appendBuf = make([]byte, 0, needed*2)
	}
	appendBuf = appendBuf[:0]
	appendBuf = append(appendBuf, appendAudioPrefix...)
	appendBuf = append(appendBuf, base64Audio...)
	appendBuf = append(appendBuf, appendAudioSuffix...)

	// Copy into a new slice for the channel since appendBuf is reused
	msg := make([]byte, len(appendBuf))
	copy(msg, appendBuf)
	rt.writeCh <- msg
}

func (rt *OpenAIRealtime) CommitBuffer() {
	rt.writeCh <- commitBufferMsg
}

func (rt *OpenAIRealtime) RequestResponse() {
	rt.timingMu.Lock()
	rt.lastRequestedAt = time.Now()
	rt.timingMu.Unlock()
	rt.writeCh <- responseCreateMsg
}

func (rt *OpenAIRealtime) trackFirstDelta(responseID string) {
	rt.timingMu.Lock()
	defer rt.timingMu.Unlock()

	if _, seen := rt.firstDeltaAt[responseID]; seen {
		return
	}

	now := time.Now()
	rt.firstDeltaAt[responseID] = now

	if !rt.lastRequestedAt.IsZero() {
		latency := now.Sub(rt.lastRequestedAt)
		log.Printf("[KPI] response_latency: %dms (response %s)", latency.Milliseconds(), responseID)
	}
}

func (rt *OpenAIRealtime) trackResponseDone(responseID string) {
	rt.timingMu.Lock()
	defer rt.timingMu.Unlock()

	if start, ok := rt.firstDeltaAt[responseID]; ok {
		totalTime := time.Since(start)
		log.Printf("[KPI] response_total_time: %dms (response %s)", totalTime.Milliseconds(), responseID)
		delete(rt.firstDeltaAt, responseID)
	}
}

func (rt *OpenAIRealtime) Subscribe() (<-chan BroadcastMessage, func()) {
	return rt.broadcaster.Subscribe()
}

func (rt *OpenAIRealtime) Close() {
	close(rt.writeCh)    // signal write loop to stop
	<-rt.writeDone       // wait for pending writes to flush
	rt.conn.Close()
	<-rt.done            // wait for read loop to finish
}
