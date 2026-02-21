package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"log"
	"time"
)

const (
	TargetBytes = 15 * BytesPerSecond // 15 seconds of audio before requesting response
	CommitBytes = 3 * BytesPerSecond  // 3 seconds between buffer commits
)

// AudioProcessor reads audio from the selected source and streams it to
// OpenAI via the Realtime API.
type AudioProcessor struct {
	source *AudioSource
	openai *OpenAIRealtime
}

func NewAudioProcessor(source *AudioSource, openai *OpenAIRealtime) *AudioProcessor {
	return &AudioProcessor{source: source, openai: openai}
}

// Run is the main processing loop. It waits for a source to be selected,
// processes audio, and restarts on error or source change.
func (ap *AudioProcessor) Run(ctx context.Context) {
	log.Println("Audio processor initialized, waiting for source selection...")

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		// Wait for a source to be selected
		sourceID := ap.waitForSource(ctx)
		if sourceID == nil {
			return // context cancelled
		}

		// Process audio for this source
		err := ap.processAudio(ctx, *sourceID)
		if err != nil {
			log.Printf("Audio processing failed, restarting... error: %v", err)
		}

		// Brief pause before retrying
		select {
		case <-time.After(time.Second):
		case <-ctx.Done():
			return
		}
	}
}

func (ap *AudioProcessor) waitForSource(ctx context.Context) *AudioSourceID {
	for {
		if id := ap.source.CurrentSource(); id != nil {
			return id
		}
		select {
		case <-time.After(time.Second):
		case <-ctx.Done():
			return nil
		}
	}
}

func (ap *AudioProcessor) processAudio(ctx context.Context, sourceID AudioSourceID) error {
	log.Printf("Source selected: %s, starting processing...", sourceID)

	// Create a cancellable context for this processing session
	procCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	audioCh, err := ap.source.Stream(procCtx)
	if err != nil {
		return fmt.Errorf("failed to start audio stream: %w", err)
	}

	accumulated := 0
	sinceCommit := 0
	chunkCount := 0
	throughputStart := time.Now()

	for chunk := range audioCh {
		// Check that the source hasn't changed
		current := ap.source.CurrentSource()
		if current == nil || *current != sourceID {
			log.Println("Source cleared, stopping audio processing")
			return nil
		}

		// Encode and send to OpenAI
		b64 := base64.StdEncoding.EncodeToString(chunk)
		if err := ap.openai.AppendAudio(b64); err != nil {
			return fmt.Errorf("failed to append audio: %w", err)
		}

		accumulated += len(chunk)
		sinceCommit += len(chunk)
		chunkCount++

		// Periodic commit (every 3 seconds of audio)
		if sinceCommit >= CommitBytes && accumulated < TargetBytes {
			if err := ap.openai.CommitBuffer(); err != nil {
				return fmt.Errorf("failed to commit buffer: %w", err)
			}
			sinceCommit = 0
		}

		// Request response after 15 seconds of audio
		if accumulated >= TargetBytes {
			elapsed := time.Since(throughputStart)
			bytesTotal := accumulated
			log.Printf("Requesting response (%.1fs of audio)", float64(accumulated)/float64(BytesPerSecond))
			if elapsed > 0 {
				chunksPerSec := float64(chunkCount) / elapsed.Seconds()
				bytesPerSec := float64(bytesTotal) / elapsed.Seconds()
				log.Printf("[KPI] chunk_throughput: %.1f chunks/s, %.0f bytes/s (%.1fx realtime)",
					chunksPerSec, bytesPerSec, bytesPerSec/float64(BytesPerSecond))
			}
			if err := ap.openai.CommitBuffer(); err != nil {
				return fmt.Errorf("failed to commit buffer: %w", err)
			}
			if err := ap.openai.RequestResponse(); err != nil {
				return fmt.Errorf("failed to request response: %w", err)
			}
			accumulated = 0
			sinceCommit = 0
			chunkCount = 0
			throughputStart = time.Now()
		}
	}

	return nil
}
