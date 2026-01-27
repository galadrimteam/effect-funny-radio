import { Effect, Either, Option, Ref, Schedule, Stream, Schema } from "effect";
import {
  AudioSource,
  BYTES_PER_SECOND,
  type AudioSourceId,
} from "./AudioSource.js";
import { OpenAIRealtime } from "./OpenAIRealtime.js";

const TARGET_BYTES = 15 * BYTES_PER_SECOND;
const COMMIT_BYTES = 3 * BYTES_PER_SECOND;

export class NoSourceError extends Schema.TaggedError<NoSourceError>()(
  "NoSourceError",
  {}
) {}

class SourceClearedError extends Schema.TaggedError<SourceClearedError>()(
  "SourceClearedError",
  {}
) {}

export class AudioProcessor extends Effect.Service<AudioProcessor>()(
  "AudioProcessor",
  {
    effect: Effect.gen(function* () {
      const audioSource = yield* AudioSource;

      const waitForSource = audioSource.currentSource.pipe(
        Effect.flatMap(Either.fromOption(() => new NoSourceError())),
        Effect.retry(Schedule.spaced("1 second"))
      );

      const processAudio = (sourceId: AudioSourceId) =>
        Effect.gen(function* () {
          yield* Effect.log(
            `Source selected: ${sourceId}, starting processing...`
          );

          const openai = yield* OpenAIRealtime;
          const accumulatedBytes = yield* Ref.make(0);
          const bytesSinceLastCommit = yield* Ref.make(0);

          yield* audioSource.getStream().pipe(
            Stream.runForEach((chunk) =>
              Effect.gen(function* () {
                // Check if source was cleared or changed
                yield* audioSource.currentSource.pipe(
                  Effect.flatMap(
                    Either.fromOption(() => new SourceClearedError())
                  ),
                  Effect.filterOrFail(
                    (current) => current === sourceId,
                    () => new SourceClearedError()
                  )
                );

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
        }).pipe(
          Effect.catchTag("SourceClearedError", () =>
            Effect.log("Source cleared, stopping audio processing")
          )
        );

      const run = Effect.gen(function* () {
        yield* Effect.log(
          "Audio processor initialized, waiting for source selection..."
        );

        // Loop: wait for source, process, repeat when cleared
        return yield* Effect.forever(
          waitForSource.pipe(Effect.flatMap(processAudio))
        );
      });

      return { run } as const;
    }),
  }
) {}
