import { Data, Effect, Either, Option, Ref, Schedule, Stream } from "effect";
import {
  AudioSource,
  BYTES_PER_SECOND,
  type AudioSourceId,
} from "./AudioSource.js";
import { OpenAIRealtime } from "./OpenAIRealtime.js";

const TARGET_BYTES = 15 * BYTES_PER_SECOND;
const COMMIT_BYTES = 3 * BYTES_PER_SECOND;

class SourceClearedError extends Data.TaggedError("SourceClearedError") {}

const assertSource = (sourceId: AudioSourceId) =>
  AudioSource.currentSource.pipe(
    Effect.filterOrFail(
      (opt) => Option.isSome(opt) && opt.value === sourceId,
      () => new SourceClearedError()
    )
  );

const processAudio = (sourceId: AudioSourceId) =>
  Effect.gen(function* () {
    yield* Effect.log(`Source selected: ${sourceId}, starting processing...`);

    const openai = yield* OpenAIRealtime;
    const accumulated = yield* Ref.make(0);
    const sinceCommit = yield* Ref.make(0);

    const audioStream = yield* AudioSource.getStream();
    yield* audioStream.pipe(
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          yield* assertSource(sourceId);
          yield* openai.appendAudio(chunk.toString("base64"));

          const acc = yield* Ref.updateAndGet(accumulated, (n) => n + chunk.length);
          const since = yield* Ref.updateAndGet(sinceCommit, (n) => n + chunk.length);

          if (since >= COMMIT_BYTES && acc < TARGET_BYTES) {
            yield* openai.commitBuffer();
            yield* Ref.set(sinceCommit, 0);
          }

          if (acc >= TARGET_BYTES) {
            yield* Effect.log(
              `Requesting response (${(acc / BYTES_PER_SECOND).toFixed(1)}s of audio)`
            );
            yield* openai.commitBuffer();
            yield* openai.requestResponse();
            yield* Ref.set(accumulated, 0);
            yield* Ref.set(sinceCommit, 0);
          }
        })
      )
    );
  }).pipe(
    Effect.catchTag("SourceClearedError", () =>
      Effect.log("Source cleared, stopping audio processing")
    )
  );

const waitForSource = AudioSource.currentSource.pipe(
  Effect.flatMap(Either.fromOption(() => "no source" as const)),
  Effect.retry(Schedule.spaced("1 second"))
);

export const runAudioProcessor = Effect.gen(function* () {
  yield* Effect.log("Audio processor initialized, waiting for source selection...");

  yield* waitForSource.pipe(
    Effect.flatMap(processAudio),
    Effect.catchAllCause((cause) =>
      Effect.logError("Audio processing failed, restarting...", cause)
    ),
    Effect.repeat(Schedule.spaced("1 second"))
  );
});
