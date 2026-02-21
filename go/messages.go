package main

import "encoding/json"

// ServerEvent represents events received from the OpenAI Realtime WebSocket.
type ServerEvent struct {
	Type       string          `json:"type"`
	ResponseID string          `json:"response_id,omitempty"`
	Delta      string          `json:"delta,omitempty"`
	Response   *EventResponse  `json:"response,omitempty"`
	Error      *EventError     `json:"error,omitempty"`
	RawJSON    json.RawMessage `json:"-"`
}

type EventResponse struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

type EventError struct {
	Message string `json:"message"`
}

// BroadcastMessage represents messages sent to SSE clients.
type BroadcastMessage struct {
	Type       string `json:"type"`
	ResponseID string `json:"responseId,omitempty"`
	Text       string `json:"text,omitempty"`
	Message    string `json:"message,omitempty"`
}
