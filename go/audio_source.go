package main

import (
	"bytes"
	"context"
	"io"
	"log"
	"os/exec"
	"sync"
)

type AudioSourceID string

const (
	SourceFranceInfo    AudioSourceID = "franceinfo"
	SourceFranceInter   AudioSourceID = "franceinter"
	SourceFranceCulture AudioSourceID = "franceculture"
)

type AudioSourceInfo struct {
	ID   AudioSourceID `json:"id"`
	Name string        `json:"name"`
	URL  string        `json:"url"`
}

var AudioSources = map[AudioSourceID]AudioSourceInfo{
	SourceFranceInfo: {
		ID:   SourceFranceInfo,
		Name: "France Info",
		URL:  "https://stream.radiofrance.fr/franceinfo/franceinfo_hifi.m3u8",
	},
	SourceFranceInter: {
		ID:   SourceFranceInter,
		Name: "France Inter",
		URL:  "https://stream.radiofrance.fr/franceinter/franceinter_hifi.m3u8",
	},
	SourceFranceCulture: {
		ID:   SourceFranceCulture,
		Name: "France Culture",
		URL:  "https://stream.radiofrance.fr/franceculture/franceculture_hifi.m3u8",
	},
}

// AudioSourceIDs returns the source IDs in a stable display order.
func AudioSourceIDs() []AudioSourceID {
	return []AudioSourceID{SourceFranceInfo, SourceFranceInter, SourceFranceCulture}
}

const (
	BytesPerSecond = 24000 * 2 // 24kHz, 16-bit mono
	BatchThreshold = BytesPerSecond / 10 // 4800 bytes (~0.1s of audio)
)

// AudioSource manages the currently selected radio source and provides
// an audio stream via ffmpeg.
type AudioSource struct {
	mu      sync.RWMutex
	current *AudioSourceID
}

func NewAudioSource() *AudioSource {
	return &AudioSource{}
}

func (a *AudioSource) CurrentSource() *AudioSourceID {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.current
}

func (a *AudioSource) SetSource(id *AudioSourceID) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.current = id
}

// Stream launches ffmpeg to decode the currently selected HLS stream into
// raw PCM audio. It returns a channel of batched audio chunks (each at least
// BatchThreshold bytes). The channel is closed when the ffmpeg process exits
// or the context is cancelled.
func (a *AudioSource) Stream(ctx context.Context) (<-chan []byte, error) {
	a.mu.RLock()
	sourceID := a.current
	a.mu.RUnlock()

	if sourceID == nil {
		ch := make(chan []byte)
		close(ch)
		return ch, nil
	}

	info := AudioSources[*sourceID]
	log.Printf("Starting audio stream from %s", info.Name)

	cmd := exec.CommandContext(ctx, "ffmpeg",
		"-fflags", "+nobuffer",
		"-flags", "+low_delay",
		"-probesize", "32",
		"-analyzeduration", "0",
		"-i", info.URL,
		"-f", "s16le",
		"-ar", "24000",
		"-ac", "1",
		"-flush_packets", "1",
		"-",
	)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}

	if err := cmd.Start(); err != nil {
		return nil, err
	}

	ch := make(chan []byte, 32)

	go func() {
		defer close(ch)
		defer func() {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}()

		buf := make([]byte, 4096)
		var acc bytes.Buffer

		for {
			n, err := stdout.Read(buf)
			if n > 0 {
				acc.Write(buf[:n])
				for acc.Len() >= BatchThreshold {
					chunk := make([]byte, BatchThreshold)
					_, _ = acc.Read(chunk)
					select {
					case ch <- chunk:
					case <-ctx.Done():
						return
					}
				}
			}
			if err != nil {
				// Flush remaining bytes
				if acc.Len() > 0 {
					remaining := make([]byte, acc.Len())
					_, _ = acc.Read(remaining)
					select {
					case ch <- remaining:
					case <-ctx.Done():
					}
				}
				if err != io.EOF {
					log.Printf("ffmpeg read error: %v", err)
				}
				return
			}
		}
	}()

	return ch, nil
}
