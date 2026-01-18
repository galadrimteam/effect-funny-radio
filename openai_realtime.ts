const audioUrl =
  "https://stream.radiofrance.fr/franceinfo/franceinfo_hifi.m3u8";

const SUMMARY_INTERVAL = 15; // in seconds
const COMMIT_INTERVAL = 3; // commit every 3 seconds within summary interval
const BYTES_PER_SECOND = 24000 * 2; // 24kHz, 16-bit (2 bytes per sample), mono
const TARGET_BYTES = SUMMARY_INTERVAL * BYTES_PER_SECOND;
const COMMIT_BYTES = COMMIT_INTERVAL * BYTES_PER_SECOND;
const BATCH_THRESHOLD = Math.floor(BYTES_PER_SECOND / 50); // ~20ms of audio

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const proc = Bun.spawn(
  [
    "ffmpeg",
    "-fflags",
    "+nobuffer",
    "-flags",
    "+low_delay",
    "-probesize",
    "32",
    "-analyzeduration",
    "0",
    "-i",
    audioUrl,
    "-f",
    "s16le",
    "-ar",
    "24000",
    "-ac",
    "1",
    "-flush_packets",
    "1",
    "-",
  ],
  {
    stdout: "pipe",
    stderr: "pipe",
  }
);

// Handle process errors
const textDecoder = new TextDecoder();
proc.stderr.pipeTo(
  new WritableStream({
    write(chunk) {
      // Log ffmpeg stderr for debugging, but don't treat as fatal
      const text = textDecoder.decode(chunk);
      if (text.includes("error") || text.includes("Error")) {
        console.error(`[${new Date().toISOString()}] ffmpeg:`, text);
      }
    },
  })
);

// Handle process exit
proc.exited.then((code) => {
  if (code !== 0 && code !== null) {
    console.error(
      `[${new Date().toISOString()}] ffmpeg process exited with code ${code}`
    );
  }
});

const audioStream = proc.stdout;

const url = "wss://api.openai.com/v1/realtime?model=gpt-realtime-mini";
const ws = new WebSocket(url, {
  headers: {
    Authorization: "Bearer " + OPENAI_API_KEY,
  },
});

const systemInstruction = `Vous êtes un humoriste de stand-up très sarcastique mais au cœur tendre, qui trouve toujours le bon côté des choses.
Transformez l'extrait audio d'actualité en une version courte, drôle et optimiste (maximum 3 à 6 phrases).
Gardez TOUS les faits importants exacts — n'inventez ni ne mentez jamais.
Rendez-la plus légère, ajoutez des observations pleines d'esprit, un brin de moquerie bienveillante sur la situation ou les politiciens, mais restez respectueux.
Terminez sur une note pleine d'espoir ou ridiculement positive.`;

const commitMessage = `{"type":"input_audio_buffer.commit"}`;
const createMessage = `{"type":"response.create"}`;

ws.addEventListener("open", async () => {
  console.log(`[${new Date().toISOString()}] Connected to server.`);

  // Send client events over the WebSocket once connected
  ws.send(
    JSON.stringify({
      type: "session.update",
      session: {
        type: "realtime",
        audio: {
          input: {
            format: {
              type: "audio/pcm",
              rate: 24000,
            },
            turn_detection: null,
            noise_reduction: null,
          },
        },
        instructions: systemInstruction,
        model: "gpt-realtime-mini",
        output_modalities: ["text"],
        tracing: "auto",
      },
    })
  );

  let accumulatedBytes = 0;
  let bytesSinceLastCommit = 0;
  let audioBuffer: Buffer[] = [];
  let audioBufferSize = 0;
  let lastResponseCreateAt = 0;
  const reader = audioStream.getReader();

  const sendAudioAppend = (buffer: Buffer) => {
    ws.send(
      `{"type":"input_audio_buffer.append","audio":"${buffer.toString("base64")}"}`
    );
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.length === 0) {
        continue;
      }

      // Batch audio chunks
      audioBuffer.push(Buffer.from(value));
      audioBufferSize += value.length;
      accumulatedBytes += value.length;
      bytesSinceLastCommit += value.length;

      // Send batched audio when threshold is reached
      if (audioBufferSize >= BATCH_THRESHOLD) {
        const combined = Buffer.concat(audioBuffer);
        sendAudioAppend(combined);
        audioBuffer = [];
        audioBufferSize = 0;
      }

      // Send commit message periodically within summary interval
      if (bytesSinceLastCommit >= COMMIT_BYTES && accumulatedBytes < TARGET_BYTES) {
        // Flush any remaining audio in buffer before committing
        if (audioBufferSize > 0) {
          const combined = Buffer.concat(audioBuffer);
          sendAudioAppend(combined);
          audioBuffer = [];
          audioBufferSize = 0;
        }
        ws.send(commitMessage);
        bytesSinceLastCommit = 0;
      }

      if (accumulatedBytes >= TARGET_BYTES) {
        // Flush any remaining audio in buffer
        if (audioBufferSize > 0) {
          const combined = Buffer.concat(audioBuffer);
          sendAudioAppend(combined);
          audioBuffer = [];
          audioBufferSize = 0;
        }

        const now = Date.now();
        const intervalSeconds =
          lastResponseCreateAt > 0
            ? ((now - lastResponseCreateAt) / 1000).toFixed(2)
            : "n/a";
        console.log(
          `[${new Date().toISOString()}] Asking for a new response (${(accumulatedBytes / BYTES_PER_SECOND).toFixed(2)}s of audio, interval ${intervalSeconds}s)`
        );
        ws.send(commitMessage);
        ws.send(createMessage);
        accumulatedBytes = 0;
        bytesSinceLastCommit = 0;
        lastResponseCreateAt = now;
      }
    }
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Error sending audio chunk to server:`,
      error
    );
  } finally {
    try {
      reader.releaseLock();
    } catch (e) {
      // Reader might already be released
    }
  }
});

let activeResponseId: string | null = null;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const startResponseStream = (responseId: string) => {
  if (activeResponseId) {
    process.stdout.write("\n");
  }
  process.stdout.write(
    `[${new Date().toISOString()}] Response ${responseId}: `
  );
  activeResponseId = responseId;
};

// Listen for and parse server events
ws.addEventListener("message", (event) => {
  const data = JSON.parse(event.data as string);
  switch (data.type) {
    case "response.output_text.delta": {
      const delta = data.delta;
      const responseId = asString(data.response_id);
      if (!activeResponseId) {
        if (!responseId) {
          break;
        }
        startResponseStream(responseId);
      } else if (responseId && responseId !== activeResponseId) {
        startResponseStream(responseId);
      }
      if (isNonEmptyString(delta)) {
        process.stdout.write(delta);
      }
      break;
    }
    case "response.done": {
      const response = data.response;
      const responseId = asString(response?.id) ?? asString(data.response_id);
      if (activeResponseId) {
        process.stdout.write("\n");
      }
      console.log(
        `[${new Date().toISOString()}] ${responseId ? `Response ${responseId}` : "Response"} done (${response?.status ?? "unknown"})`
      );
      activeResponseId = null;
      break;
    }
    case "error":
      console.error(`[${new Date().toISOString()}] Error:`, data);
      break;
    default:
      break;
  }
});

// Graceful shutdown
function shutdown() {
  console.log(`[${new Date().toISOString()}] Shutting down...`);
  ws.close();
  proc.kill();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
