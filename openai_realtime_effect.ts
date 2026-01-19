import { Command, Terminal } from "@effect/platform";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import {
  Config,
  Data,
  Effect,
  Option,
  Queue,
  Ref,
  Redacted,
  Stream,
} from "effect";

// Constants
const AUDIO_URL =
  "https://stream.radiofrance.fr/franceinfo/franceinfo_hifi.m3u8";
const BYTES_PER_SECOND = 24000 * 2;
const TARGET_BYTES = 15 * BYTES_PER_SECOND;
const COMMIT_BYTES = 3 * BYTES_PER_SECOND;
const BATCH_THRESHOLD = Math.floor(BYTES_PER_SECOND / 50);
const OPENAI_URL = "wss://api.openai.com/v1/realtime?model=gpt-realtime-mini";

const systemInstruction = `Vous êtes un humoriste de stand-up très sarcastique mais au cœur tendre, qui trouve toujours le bon côté des choses.
Transformez l'extrait audio d'actualité en une version courte, drôle et optimiste (maximum 3 à 6 phrases).
Gardez TOUS les faits importants exacts — n'inventez ni ne mentez jamais.
Rendez-la plus légère, ajoutez des observations pleines d'esprit, un brin de moquerie bienveillante sur la situation ou les politiciens, mais restez respectueux.
Terminez sur une note pleine d'espoir ou ridiculement positive.`;

// OpenAI Realtime Server Events (only fields we use)
type ServerEvent =
  | { type: "response.output_text.delta"; response_id: string; delta: string }
  | { type: "response.done"; response: { id: string; status: string } }
  | { type: "error"; error: { message: string } }
  | { type: string };

class WebSocketError extends Data.TaggedError("WebSocketError")<{
  cause: unknown;
}> {}

class OpenAIWebSocket extends Effect.Service<OpenAIWebSocket>()(
  "OpenAIWebSocket",
  {
    scoped: Effect.gen(function* () {
      const apiKey = yield* Config.redacted("OPENAI_API_KEY");
      const queue = yield* Queue.unbounded<ServerEvent>();

      const ws = yield* Effect.acquireRelease(
        Effect.async<WebSocket, WebSocketError>((resume) => {
          const ws = new WebSocket(OPENAI_URL, {
            headers: { Authorization: `Bearer ${Redacted.value(apiKey)}` },
          });
          ws.addEventListener("open", () => resume(Effect.succeed(ws)));
          ws.addEventListener("error", (e) =>
            resume(Effect.fail(new WebSocketError({ cause: e })))
          );
        }),
        (ws) => Effect.sync(() => ws.close())
      );

      ws.addEventListener("message", (e) => {
        try {
          Queue.unsafeOffer(queue, JSON.parse(e.data as string));
        } catch {}
      });

      return {
        send: (msg: string) => Effect.sync(() => ws.send(msg)),
        messages: Stream.fromQueue(queue),
      };
    }),
  }
) {}

const audioStream = Command.make(
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
  AUDIO_URL,
  "-f",
  "s16le",
  "-ar",
  "24000",
  "-ac",
  "1",
  "-flush_packets",
  "1",
  "-"
).pipe(Command.stream);

const batchByBytes = <E, R>(stream: Stream.Stream<Uint8Array, E, R>) =>
  stream.pipe(
    Stream.mapAccum({ buf: [] as Uint8Array[], size: 0 }, (s, chunk) => {
      const size = s.size + chunk.length;
      return size >= BATCH_THRESHOLD
        ? [{ buf: [], size: 0 }, Option.some(Buffer.concat([...s.buf, chunk]))]
        : [{ buf: [...s.buf, chunk], size }, Option.none()];
    }),
    Stream.filterMap((x) => x)
  );

const program = Effect.gen(function* () {
  const ws = yield* OpenAIWebSocket;
  const terminal = yield* Terminal.Terminal;
  const accumulatedBytes = yield* Ref.make(0);
  const bytesSinceLastCommit = yield* Ref.make(0);
  const activeResponseId = yield* Ref.make<string | null>(null);

  yield* Effect.log("Connected to OpenAI Realtime API");

  yield* ws.send(
    JSON.stringify({
      type: "session.update",
      session: {
        type: "realtime",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
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

  yield* Effect.fork(
    Stream.runForEach(ws.messages, (msg) =>
      Effect.gen(function* () {
        if (msg.type === "response.output_text.delta" && "delta" in msg) {
          const currentResponseId = yield* Ref.get(activeResponseId);
          if (currentResponseId !== msg.response_id) {
            if (currentResponseId) yield* terminal.display("\n");
            yield* Effect.log(`Response ${msg.response_id} started`);
            yield* Ref.set(activeResponseId, msg.response_id);
          }
          yield* terminal.display(msg.delta);
        } else if (msg.type === "response.done" && "response" in msg) {
          yield* terminal.display("\n");
          yield* Effect.log(
            `Response ${msg.response.id} done (${msg.response.status})`
          );
          yield* Ref.set(activeResponseId, null);
        } else if (msg.type === "error" && "error" in msg) {
          yield* Effect.logError(`OpenAI error: ${msg.error.message}`);
        }
      })
    )
  );

  yield* Effect.log("Starting audio stream...");

  yield* audioStream.pipe(
    batchByBytes,
    Stream.runForEach((chunk) =>
      Effect.gen(function* () {
        yield* ws.send(
          `{"type":"input_audio_buffer.append","audio":"${chunk.toString("base64")}"}`
        );
        const acc = yield* Ref.updateAndGet(
          accumulatedBytes,
          (n) => n + chunk.length
        );
        const since = yield* Ref.updateAndGet(
          bytesSinceLastCommit,
          (n) => n + chunk.length
        );

        if (since >= COMMIT_BYTES && acc < TARGET_BYTES) {
          yield* ws.send('{"type":"input_audio_buffer.commit"}');
          yield* Ref.set(bytesSinceLastCommit, 0);
        }
        if (acc >= TARGET_BYTES) {
          yield* Effect.log(
            `Requesting response (${(acc / BYTES_PER_SECOND).toFixed(1)}s)`
          );
          yield* ws.send('{"type":"input_audio_buffer.commit"}');
          yield* ws.send('{"type":"response.create"}');
          yield* Ref.set(accumulatedBytes, 0);
          yield* Ref.set(bytesSinceLastCommit, 0);
        }
      })
    )
  );
});

BunRuntime.runMain(
  program.pipe(
    Effect.provide(OpenAIWebSocket.Default),
    Effect.provide(BunContext.layer)
  )
);
