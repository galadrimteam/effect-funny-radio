import {
  Command,
  CommandExecutor,
  Error as PlatformError,
} from "@effect/platform";
import { Effect, Option, Ref, Sink, Stream } from "effect";

export const AUDIO_SOURCES = {
  franceinfo: {
    name: "France Info",
    url: "https://stream.radiofrance.fr/franceinfo/franceinfo_hifi.m3u8",
  },
  franceinter: {
    name: "France Inter",
    url: "https://stream.radiofrance.fr/franceinter/franceinter_hifi.m3u8",
  },
  franceculture: {
    name: "France Culture",
    url: "https://stream.radiofrance.fr/franceculture/franceculture_hifi.m3u8",
  },
} as const;

export type AudioSourceId = keyof typeof AUDIO_SOURCES;

export const BYTES_PER_SECOND = 24000 * 2;
const BATCH_THRESHOLD = Math.floor(BYTES_PER_SECOND / 50);

const batchByBytes = <E, R>(stream: Stream.Stream<Uint8Array, E, R>) =>
  stream.pipe(
    Stream.transduce(
      Sink.foldWeighted({
        initial: [] as Uint8Array[],
        maxCost: BATCH_THRESHOLD,
        cost: (chunk) => chunk.length,
        body: (acc, chunk) => [...acc, chunk],
      })
    ),
    Stream.map((chunks) => Buffer.concat(chunks))
  );

const ffmpegStream = (url: string) =>
  Command.make(
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
    url,
    "-f",
    "s16le",
    "-ar",
    "24000",
    "-ac",
    "1",
    "-flush_packets",
    "1",
    "-"
  ).pipe(Command.stream, batchByBytes);

export class AudioSource extends Effect.Service<AudioSource>()("AudioSource", {
  accessors: true,
  effect: Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor;
    const sourceRef = yield* Ref.make(Option.none<AudioSourceId>());

    return {
      currentSource: Ref.get(sourceRef),
      setSource: (id: AudioSourceId | null) =>
        Ref.set(sourceRef, Option.fromNullable(id)),
      getStream: (): Stream.Stream<Buffer, PlatformError.PlatformError> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const sourceId = Option.getOrNull(yield* Ref.get(sourceRef));
            if (!sourceId) return Stream.empty;
            yield* Effect.log(
              `Starting audio stream from ${AUDIO_SOURCES[sourceId].name}`
            );
            return ffmpegStream(AUDIO_SOURCES[sourceId].url).pipe(
              Stream.provideService(CommandExecutor.CommandExecutor, executor)
            );
          })
        ),
    };
  }),
}) {}
