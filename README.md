# Funny Radio - AI-Powered Sarcastic News Transformer

Transform French radio news into sarcastic, optimistic summaries using OpenAI's Realtime API.

This application streams live audio from French radio stations (France Info, France Inter, France Culture), processes it through OpenAI's Realtime API, and generates witty, sarcastic-yet-hopeful summaries of the news in French.

## Features

- Stream live French radio audio (Radio France stations)
- Real-time speech-to-text and AI transformation using OpenAI Realtime API
- Sarcastic, optimistic news summaries while keeping facts accurate
- Server-Sent Events (SSE) stream for real-time message delivery
- REST API for source management
- Web UI for easy interaction
- Built with Effect for type-safe functional programming

## Prerequisites

- [Bun](https://bun.sh) runtime (v1.3.6 or later)
- [ffmpeg](https://ffmpeg.org) installed and available in PATH
- OpenAI API key with Realtime API access

## Installation

1. Clone the repository
2. Install dependencies:

```bash
bun install
```

3. Create a `.env` file with your OpenAI API key:

```bash
OPENAI_API_KEY=sk-...
```

Optional: Set a custom port (defaults to 3000)

```bash
PORT=8080
```

## Running the Application

### Development Mode

Run directly from source (fastest for development):

```bash
bun run dev
```

### Production Mode

Build and run the optimized bundle:

```bash
bun run build
bun run start
```

The server will start and display:

```
Server: http://localhost:3000 | Docs: http://localhost:3000/docs
```

Visit the web UI at `http://localhost:3000` or access the API documentation at `http://localhost:3000/docs`.

## API Reference

### List Available Audio Sources

```bash
curl http://localhost:3000/sources
```

Response:

```json
{
  "sources": [
    {
      "id": "franceinfo",
      "name": "France Info",
      "url": "https://stream.radiofrance.fr/franceinfo/franceinfo_hifi.m3u8"
    },
    {
      "id": "franceinter",
      "name": "France Inter",
      "url": "https://stream.radiofrance.fr/franceinter/franceinter_hifi.m3u8"
    },
    {
      "id": "franceculture",
      "name": "France Culture",
      "url": "https://stream.radiofrance.fr/franceculture/franceculture_hifi.m3u8"
    }
  ],
  "current": null
}
```

### Set the Audio Source

```bash
curl -X POST http://localhost:3000/sources \
  -H "Content-Type: application/json" \
  -d '{"source": "franceinfo"}'
```

Available sources: `franceinfo`, `franceinter`, `franceculture`

Response:

```json
{
  "success": true,
  "current": "franceinfo",
  "name": "France Info"
}
```

### Clear the Audio Source

```bash
curl -X POST http://localhost:3000/sources \
  -H "Content-Type: application/json" \
  -d '{"source": null}'
```

### Subscribe to Message Stream (SSE)

```bash
curl -N http://localhost:3000/stream
```

The stream returns Server-Sent Events with the following message types:

- `delta`: Text chunk from AI response
  ```json
  {"type": "delta", "responseId": "resp_123", "text": "Et bien sûr..."}
  ```

- `complete`: Response finished
  ```json
  {"type": "complete", "responseId": "resp_123"}
  ```

- `error`: Error occurred
  ```json
  {"type": "error", "message": "Connection failed"}
  ```

Note: The stream endpoint returns 503 Service Unavailable if no audio source is selected.

## Project Structure

```
src/
├── main.ts              # Application entry point and layer composition
├── HttpApi.ts           # HTTP API definition (routes, schemas, handlers)
├── AudioSource.ts       # Audio stream management (ffmpeg integration)
├── AudioProcessor.ts    # Audio processing effect (chunks → OpenAI)
├── OpenAIRealtime.ts    # OpenAI Realtime API WebSocket client
├── Messages.ts          # Shared domain types (BroadcastMessage, ServerEvent)
├── SystemPrompt.ts      # AI system instruction
└── index.html           # Web UI
```

### Layer Graph

```
AppLive
├── HttpLive
│   ├── HttpApiBuilder.serve (HttpMiddleware.logger)
│   ├── HttpApiScalar (/docs)
│   ├── FunnyRadioApiLive
│   │   ├── uiGroupLive        → serves index.html
│   │   ├── sourcesGroupLive   → AudioSource
│   │   └── streamGroupLive    → AudioSource, OpenAIRealtime
│   ├── HttpServer.withLogAddress
│   └── HttpServerLive (BunHttpServer, port from Config)
├── AudioProcessingLive
│   └── runAudioProcessor (forked Effect)
│       → AudioSource, OpenAIRealtime
└── ServicesLive
    ├── AudioSource.Default
    │   └── BunContext.layer (CommandExecutor for ffmpeg)
    └── OpenAIRealtime.Default
```

## How It Works

1. User selects a French radio station via the API or web UI
2. AudioSource starts streaming audio using ffmpeg (HLS → PCM 24kHz)
3. AudioProcessor batches audio chunks and sends them to OpenAI Realtime API
4. OpenAI processes 15 seconds of audio, generates sarcastic summaries
5. Messages are broadcast via SSE to all connected clients
6. Web UI or curl clients receive real-time updates

## Tech Stack

- [Bun](https://bun.sh) - Fast JavaScript runtime
- [Effect](https://effect.website) - Functional programming framework
- [@effect/platform](https://effect.website/docs/platform/introduction) - HTTP API, commands, streams
- [OpenAI Realtime API](https://platform.openai.com/docs/guides/realtime) - Speech-to-text and AI transformation
- [ffmpeg](https://ffmpeg.org) - Audio stream processing

## Development

Run in development mode (no build required):

```bash
bun run dev
```

Type check:

```bash
bun run check
```

Format code:

```bash
bun run format
```

Build for production:

```bash
bun run build
```

The build process:
- Bundles all TypeScript modules using Bun's native bundler
- Outputs optimized `main.js` (4.7 MB) to `dist/`
- Generates source maps for debugging
- Copies `index.html` to `dist/`

Run the built application:

```bash
bun run start
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
