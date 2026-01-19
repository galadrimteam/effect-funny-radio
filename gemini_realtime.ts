import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";

/**
 * There is an issue with Gemini Live API when expecting only text as output with live audio input.
 * https://discuss.ai.google.dev/t/gemini-2-5-flash-native-audio-preview-09-2025-text-text-only-not-working/107467
 */

const audioUrl =
  "https://stream.radiofrance.fr/franceinfo/franceinfo_hifi.m3u8";

// ffmpeg output format: raw signed 16-bit little-endian PCM, 16kHz, mono
// -f s16le: signed 16-bit little-endian PCM (raw, no container/headers)
// -ar 16000: 16kHz sample rate
// -ac 1: mono (1 channel)
// -: output to stdout
const proc = Bun.spawn(
  ["ffmpeg", "-i", audioUrl, "-f", "s16le", "-ar", "16000", "-ac", "1", "-"],
  {
    stdout: "pipe",
    stderr: "pipe",
  }
);

// Handle process errors
proc.stderr.pipeTo(
  new WritableStream({
    write(chunk) {
      // Log ffmpeg stderr for debugging, but don't treat as fatal
      const text = new TextDecoder().decode(chunk);
      if (text.includes("error") || text.includes("Error")) {
        console.error("ffmpeg:", text);
      }
    },
  })
);

// Handle process exit
proc.exited.then((code) => {
  if (code !== 0 && code !== null) {
    console.error(`ffmpeg process exited with code ${code}`);
  }
});

const audioStream = proc.stdout;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const systemInstruction = `Vous êtes un humoriste de stand-up très sarcastique mais au cœur tendre, qui trouve toujours le bon côté des choses.
Transformez l'extrait audio d'actualité en une version courte, drôle et optimiste (maximum 3 à 6 phrases).
Gardez TOUS les faits importants exacts — n'inventez ni ne mentez jamais.
Rendez-la plus légère, ajoutez des observations pleines d'esprit, un brin de moquerie bienveillante sur la situation ou les politiciens, mais restez respectueux.
Terminez sur une note pleine d'espoir ou ridiculement positive.`;

const session = await ai.live.connect({
  model: "gemini-2.5-flash-native-audio-preview-12-2025",
  config: {
    responseModalities: [Modality.TEXT],
    systemInstruction: systemInstruction,
    realtimeInputConfig: {
      automaticActivityDetection: {
        disabled: true,
      },
    },
  },
  callbacks: {
    onopen: () => {
      console.log("Connected to the socket.");
    },
    onmessage: (e: LiveServerMessage) => {
      console.log("Received message from the server: %s\n", e.data);
    },
    onerror: (e: ErrorEvent) => {
      console.log("Error occurred: %s\n", e.error);
    },
    onclose: (e: CloseEvent) => {
      console.log("Connection closed.", e);
    },
  },
});

// Start the first activity
session.sendRealtimeInput({
  activityStart: {},
});

// Set up interval to send activityEnd/activityStart every 10 seconds
let activityInterval = setInterval(() => {
  session.sendRealtimeInput({
    activityEnd: {},
  });
  session.sendRealtimeInput({
    activityStart: {},
  });
}, 5000);

// Consume audio stream and send chunks
const reader = audioStream.getReader();

(async () => {
  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        console.log("Audio stream ended.");
        break;
      }

      if (!value || value.length === 0) {
        continue;
      }

      // Convert audio chunk to base64
      // value is raw 16-bit PCM (2 bytes per sample), 16kHz, mono
      // Each sample is 2 bytes (16-bit), so chunk length should be even
      if (value.length % 2 !== 0) {
        console.warn(
          `Audio chunk length is odd (${value.length} bytes), expected even for 16-bit samples`
        );
      }

      const base64Audio = Buffer.from(value).toString("base64");

      // Send audio chunk
      // Format: 16-bit PCM, 16kHz, mono
      try {
        session.sendRealtimeInput({
          audio: {
            data: base64Audio,
            mimeType: "audio/pcm;rate=16000",
          },
        });
      } catch (sendError) {
        console.error("Error sending audio chunk:", sendError);
        // Continue reading even if send fails
      }
    }
  } catch (error) {
    console.error("Error reading audio stream:", error);
  } finally {
    clearInterval(activityInterval);
    try {
      reader.releaseLock();
    } catch (e) {
      // Reader might already be released
    }
    // Send final activityEnd
    try {
      session.sendRealtimeInput({
        activityEnd: {},
      });
    } catch (e) {
      // Session might already be closed
    }
  }
})();
