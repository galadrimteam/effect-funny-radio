import { Effect, Option, Ref, Schedule, Stream } from "effect";
import { AudioSource, BYTES_PER_SECOND } from "./AudioSource.js";
import { OpenAIRealtime } from "./OpenAIRealtime.js";

// Timing constants for audio buffering
const TARGET_BYTES = 15 * BYTES_PER_SECOND; // Request response after 15s of audio
const COMMIT_BYTES = 3 * BYTES_PER_SECOND; // Commit buffer every 3s

export class AudioProcessor extends Effect.Service<AudioProcessor>()(
  "AudioProcessor",
  {
    effect: Effect.gen(function* () {
      return {
        run: Effect.gen(function* () {
          const audioSource = yield* AudioSource;
          const openai = yield* OpenAIRealtime;

          yield* Effect.log(
            "Audio processor initialized, waiting for source selection..."
          );

          // Wait until a source is selected
          yield* Effect.gen(function* () {
            const maybeCurrent = yield* audioSource.currentSource;
            if (Option.isNone(maybeCurrent)) {
              return yield* Effect.fail("no source");
            }
            return maybeCurrent.value;
          }).pipe(
            Effect.retry(Schedule.spaced("1 second")),
            Effect.tap((sourceId) =>
              Effect.log(`Source selected: ${sourceId}, starting processing...`)
            )
          );

          const accumulatedBytes = yield* Ref.make(0);
          const bytesSinceLastCommit = yield* Ref.make(0);

          yield* audioSource.getStream().pipe(
            Stream.runForEach((chunk) =>
              Effect.gen(function* () {
                // Send audio chunk to OpenAI
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

                // Commit buffer periodically
                if (since >= COMMIT_BYTES && acc < TARGET_BYTES) {
                  yield* openai.send('{"type":"input_audio_buffer.commit"}');
                  yield* Ref.set(bytesSinceLastCommit, 0);
                }

                // Request response after accumulating enough audio
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
        }),
      };
    }),
  }
) {}

export const AudioProcessorLive = AudioProcessor.Default;
