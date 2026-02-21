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
	writeMu     sync.Mutex
	done        chan struct{}

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
		done:         make(chan struct{}),
		firstDeltaAt: make(map[string]time.Time),
	}

	// Start read loop
	go rt.readLoop()

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

func (rt *OpenAIRealtime) send(msg any) error {
	rt.writeMu.Lock()
	defer rt.writeMu.Unlock()
	return rt.conn.WriteJSON(msg)
}

func (rt *OpenAIRealtime) AppendAudio(base64Audio string) error {
	return rt.send(map[string]string{
		"type":  "input_audio_buffer.append",
		"audio": base64Audio,
	})
}

func (rt *OpenAIRealtime) CommitBuffer() error {
	return rt.send(map[string]string{
		"type": "input_audio_buffer.commit",
	})
}

func (rt *OpenAIRealtime) RequestResponse() error {
	rt.timingMu.Lock()
	rt.lastRequestedAt = time.Now()
	rt.timingMu.Unlock()
	return rt.send(map[string]string{
		"type": "response.create",
	})
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
	rt.conn.Close()
	<-rt.done // wait for read loop to finish
}
