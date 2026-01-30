---
description: Effect Funny Radio - AI-powered sarcastic news transformer
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

# Funny Radio - Sarcastic News Transformer

This project transforms French radio news into sarcastic, optimistic summaries using OpenAI's Realtime API.

## Runtime & Tooling

Use Bun instead of Node.js:

- Use `bun run dev` to run the application in development mode (fastest)
- Use `bun run build` to build an optimized production bundle
- Use `bun run start` to run the built application
- Use `bun install` for dependencies
- Use `bun test` for testing
- Use `bunx <package>` instead of `npx`
- Bun automatically loads .env files
- Build process uses Bun's native bundler (not tsc) to create a single optimized bundle

## Project Architecture

This project uses **Effect** (effect-ts) for functional programming patterns:

- **Effect.Service**: All major components are Effect services (AudioSource, AudioProcessor, OpenAIRealtime)
- **Layers**: Dependencies are composed using Effect layers (see src/main.ts)
- **Streams**: Audio processing uses Effect streams for reactive data flow
- **Error handling**: Typed errors using Schema.TaggedError
- **Concurrency**: Uses Ref, Queue, PubSub for state management

### Key Modules

- **src/main.ts**: Application entry point, layer composition
- **src/HttpApi.ts**: HTTP API definition using @effect/platform HttpApi
- **src/AudioSource.ts**: Manages French radio stream sources, uses ffmpeg via Command
- **src/AudioProcessor.ts**: Processes audio chunks and sends to OpenAI
- **src/OpenAIRealtime.ts**: WebSocket connection to OpenAI Realtime API
- **src/index.html**: Web UI served at root

### Dependencies

- **@effect/platform**: Cross-platform Effect APIs (HTTP, Command, etc.)
- **@effect/platform-bun**: Bun-specific platform implementations
- **effect**: Core Effect library (3.x)

## Development Patterns

When working on this codebase:

- **Always run `bun run check` after modifying any `.ts` file** to catch type errors early
- Follow Effect service patterns - use `Effect.gen` for sequential operations
- Use `Layer.provide` to compose dependencies
- Prefer Effect's `Stream` for reactive data processing
- Use `Schema` for validation and type-safe errors
- For HTTP endpoints, extend HttpApiGroup in HttpApi.ts
- Audio processing constants in AudioSource.ts (BYTES_PER_SECOND, etc.)

## External Dependencies

- **ffmpeg**: Required for audio stream processing (convert HLS to PCM)
- **OpenAI API key**: Required in OPENAI_API_KEY environment variable
- **French Radio streams**: Uses Radio France public HLS streams
