package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
)

//go:embed index.html
var staticFS embed.FS

// Handlers holds dependencies for HTTP handlers.
type Handlers struct {
	Source *AudioSource
	OpenAI *OpenAIRealtime
}

// HandleIndex serves the embedded index.html.
func (h *Handlers) HandleIndex(w http.ResponseWriter, r *http.Request) {
	data, err := staticFS.ReadFile("index.html")
	if err != nil {
		http.Error(w, "index.html not found", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write(data)
}

type sourcesResponse struct {
	Sources []AudioSourceInfo `json:"sources"`
	Current *AudioSourceID    `json:"current"`
}

// HandleGetSources returns the list of available sources and the current selection.
func (h *Handlers) HandleGetSources(w http.ResponseWriter, r *http.Request) {
	sources := make([]AudioSourceInfo, 0, len(AudioSources))
	for _, id := range AudioSourceIDs() {
		sources = append(sources, AudioSources[id])
	}

	resp := sourcesResponse{
		Sources: sources,
		Current: h.Source.CurrentSource(),
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

type setSourceRequest struct {
	Source *AudioSourceID `json:"source"`
}

type setSourceResponse struct {
	Success bool           `json:"success"`
	Current *AudioSourceID `json:"current"`
	Name    *string        `json:"name"`
}

// HandleSetSource sets or clears the current audio source.
func (h *Handlers) HandleSetSource(w http.ResponseWriter, r *http.Request) {
	var req setSourceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	h.Source.SetSource(req.Source)

	var name *string
	if req.Source != nil {
		if info, ok := AudioSources[*req.Source]; ok {
			name = &info.Name
			log.Printf("Audio source changed to: %s", info.Name)
		}
	} else {
		log.Println("Audio source cleared")
	}

	resp := setSourceResponse{
		Success: true,
		Current: req.Source,
		Name:    name,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// HandleStream provides a Server-Sent Events stream of broadcast messages.
func (h *Handlers) HandleStream(w http.ResponseWriter, r *http.Request) {
	if h.Source.CurrentSource() == nil {
		http.Error(w, "no source selected", http.StatusServiceUnavailable)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	sub, unsub := h.OpenAI.Subscribe()
	defer unsub()

	ctx := r.Context()
	for {
		select {
		case msg, ok := <-sub:
			if !ok {
				return
			}
			data, err := json.Marshal(msg)
			if err != nil {
				log.Printf("Failed to marshal SSE message: %v", err)
				continue
			}
			fmt.Fprintf(w, "data: %s\n\n", data)
			flusher.Flush()
		case <-ctx.Done():
			return
		}
	}
}
