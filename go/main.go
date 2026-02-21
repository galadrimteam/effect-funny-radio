package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}

	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		log.Fatal("OPENAI_API_KEY environment variable is required")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Initialize services
	broadcaster := NewBroadcaster()
	audioSource := NewAudioSource()

	openai, err := NewOpenAIRealtime(ctx, apiKey, broadcaster)
	if err != nil {
		log.Fatalf("Failed to connect to OpenAI: %v", err)
	}

	processor := NewAudioProcessor(audioSource, openai)

	handlers := &Handlers{
		Source: audioSource,
		OpenAI: openai,
	}

	// Set up router
	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	r.Get("/", handlers.HandleIndex)
	r.Get("/sources", handlers.HandleGetSources)
	r.Post("/sources", handlers.HandleSetSource)
	r.Get("/stream", handlers.HandleStream)

	// Start audio processor in background
	go processor.Run(ctx)

	// Start HTTP server
	srv := &http.Server{
		Addr:    ":" + port,
		Handler: r,
	}

	go func() {
		log.Printf("Server listening on http://localhost:%s", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("HTTP server error: %v", err)
		}
	}()

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("Shutting down...")
	cancel()

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("HTTP server shutdown error: %v", err)
	}

	openai.Close()
	broadcaster.Close()

	log.Println("Goodbye!")
}
