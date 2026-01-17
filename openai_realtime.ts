import WebSocket from "ws";

const audioUrl =
  "https://stream.radiofrance.fr/franceinfo/franceinfo_hifi.m3u8";

const audioTreatmentInterval = 5000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const proc = Bun.spawn(
  ["ffmpeg", "-i", audioUrl, "-f", "s16le", "-ar", "24000", "-ac", "1", "-"],
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

ws.on("open", function open() {
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
      },
    })
  );

  let activityInterval = setInterval(() => {
    console.log(`[${new Date().toISOString()}] Asking for a new response`);
    ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    ws.send(JSON.stringify({ type: "response.create" }));
    ws.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
  }, audioTreatmentInterval);

  const reader = audioStream.getReader();
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (!value || value.length === 0) {
          continue;
        }
        const base64Audio = Buffer.from(value).toString("base64");
        ws.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: base64Audio,
          })
        );
      }
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] Error sending audio chunk to server:`,
        error
      );
    } finally {
      clearInterval(activityInterval);
      try {
        reader.releaseLock();
      } catch (e) {
        // Reader might already be released
      }
    }
  })();
});

// Listen for and parse server events
ws.on("message", function incoming(message) {
  // console.log(`[${new Date().toISOString()}]`, JSON.parse(message.toString()));
  const data = JSON.parse(message.toString());
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
