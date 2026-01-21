import { Effect, Option, Ref, Schedule, Stream } from "effect";
import { AudioSource, BYTES_PER_SECOND } from "./AudioSource.js";
import { OpenAIRealtime } from "./OpenAIRealtime.js";

const TARGET_BYTES = 15 * BYTES_PER_SECOND;
const COMMIT_BYTES = 3 * BYTES_PER_SECOND;

export class AudioProcessor extends Effect.Service<AudioProcessor>()(
  "AudioProcessor",
  {
    effect: Effect.gen(function* () {
      const audioSource = yield* AudioSource;
      const openai = yield* OpenAIRealtime;

      const run = Effect.gen(function* () {
        yield* Effect.log(
          "Audio processor initialized, waiting for source selection..."
        );

        // Wait until a source is selected
        yield* audioSource.currentSource.pipe(
          Effect.flatMap((opt) =>
            Option.match(opt, {
              onNone: () => Effect.fail("no source" as const),
              onSome: Effect.succeed,
            })
          ),
          Effect.retry(Schedule.spaced("1 second")),
          Effect.tap((id) =>
            Effect.log(`Source selected: ${id}, starting processing...`)
          )
        );

        const accumulatedBytes = yield* Ref.make(0);
        const bytesSinceLastCommit = yield* Ref.make(0);

        yield* audioSource.getStream().pipe(
          Stream.runForEach((chunk) =>
            Effect.gen(function* () {
              yield* openai.send(
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
                yield* openai.send('{"type":"input_audio_buffer.commit"}');
                yield* Ref.set(bytesSinceLastCommit, 0);
              }

              if (acc >= TARGET_BYTES) {
                yield* Effect.log(
                  `Requesting response (${(acc / BYTES_PER_SECOND).toFixed(1)}s of audio)`
                );
                yield* openai.send('{"type":"input_audio_buffer.commit"}');
                yield* openai.send('{"type":"response.create"}');
                yield* Ref.set(accumulatedBytes, 0);
                yield* Ref.set(bytesSinceLastCommit, 0);
              }
            })
          )
        );
      });

      return { run } as const;
    }),
  }
) {}
