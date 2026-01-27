# effect-funny-radio

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run src/main.ts
```

## API Examples

### List available audio sources

```bash
curl http://localhost:3000/sources
```

### Set the audio source

```bash
curl -X POST http://localhost:3000/sources \
  -H "Content-Type: application/json" \
  -d '{"source": "franceinfo"}'
```

Available sources: `franceinfo`, `franceinter`, `franceculture`

### Clear the audio source

```bash
curl -X POST http://localhost:3000/sources \
  -H "Content-Type: application/json" \
  -d '{"source": null}'
```

### Subscribe to the message stream (SSE)

```bash
curl -N http://localhost:3000/stream
```

This project was created using `bun init` in bun v1.3.6. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
