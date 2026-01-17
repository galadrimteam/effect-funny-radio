const audioUrl =
  "https://stream.radiofrance.fr/franceinfo/franceinfo_hifi.m3u8";

const audioTreatmentInterval = 20000; // in milliseconds
const BYTES_PER_SECOND = 24000 * 2; // 24kHz, 16-bit (2 bytes per sample), mono
const TARGET_BYTES = (audioTreatmentInterval / 1000) * BYTES_PER_SECOND;
const BATCH_THRESHOLD = BYTES_PER_SECOND / 10; // 100ms of audio (4800 bytes)

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Pre-stringify static messages
const commitMessage = JSON.stringify({ type: "input_audio_buffer.commit" });
const createMessage = JSON.stringify({ type: "response.create" });
const clearMessage = JSON.stringify({ type: "input_audio_buffer.clear" });

const proc = Bun.spawn(
  [
    "ffmpeg",
    "-fflags",
    "+nobuffer",
    "-flags",
    "+low_delay",
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

const url = "wss://api.openai.com/v1/realtime?model=gpt-realtime";
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
  let audioBuffer: Buffer[] = [];
  let audioBufferSize = 0;
  const reader = audioStream.getReader();

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

      // Send batched audio when threshold is reached
      if (audioBufferSize >= BATCH_THRESHOLD) {
        const combined = Buffer.concat(audioBuffer);
        ws.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: combined.toString("base64"),
          })
        );
        audioBuffer = [];
        audioBufferSize = 0;
      }

      if (accumulatedBytes >= TARGET_BYTES) {
        // Flush any remaining audio in buffer
        if (audioBufferSize > 0) {
          const combined = Buffer.concat(audioBuffer);
          ws.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: combined.toString("base64"),
            })
          );
          audioBuffer = [];
          audioBufferSize = 0;
        }

        console.log(
          `[${new Date().toISOString()}] Asking for a new response (${(accumulatedBytes / BYTES_PER_SECOND).toFixed(2)}s of audio)`
        );
        ws.send(commitMessage);
        ws.send(createMessage);
        ws.send(clearMessage);
        accumulatedBytes = 0;
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

// Listen for and parse server events
ws.addEventListener("message", (event) => {
  const data = JSON.parse(event.data as string);
  if (data.type === "response.done") {
    const response = data.response;
    if (response.status === "completed") {
      const text = response.output[0].content[0].text;
      console.log(`[${new Date().toISOString()}] Response completed:`, text);
    }
  }
  if (data.type === "error") {
    console.error(`[${new Date().toISOString()}] Error:`, data);
  }
});
