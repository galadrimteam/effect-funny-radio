import {
  Command,
  CommandExecutor,
  Error as PlatformError,
} from "@effect/platform";
import { Effect, Option, Ref, Stream } from "effect";

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
    Stream.mapAccum({ buf: [] as Uint8Array[], size: 0 }, (s, chunk) => {
      const size = s.size + chunk.length;
      return size >= BATCH_THRESHOLD
        ? [{ buf: [], size: 0 }, Option.some(Buffer.concat([...s.buf, chunk]))]
        : [{ buf: [...s.buf, chunk], size }, Option.none()];
    }),
    Stream.filterMap((x) => x)
  );

const createAudioStream = (url: string) =>
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
    const sourceRef = yield* Ref.make<Option.Option<AudioSourceId>>(
      Option.none()
    );

    return {
      currentSource: Ref.get(sourceRef),
      setSource: (id: AudioSourceId | null) =>
        Ref.set(sourceRef, Option.fromNullable(id)),
      getStream: (): Stream.Stream<
        Buffer,
        PlatformError.PlatformError,
        CommandExecutor.CommandExecutor
      > =>
        Stream.unwrap(
          Ref.get(sourceRef).pipe(
            Effect.map((maybeSourceId) =>
              Option.match(maybeSourceId, {
                onNone: () => Stream.empty,
                onSome: (sourceId) => {
                  const source = AUDIO_SOURCES[sourceId];
                  return Stream.fromEffect(
                    Effect.log(`Starting audio stream from ${source.name}`)
                  ).pipe(Stream.flatMap(() => createAudioStream(source.url)));
                },
              })
            )
          )
        ),
    };
  }),
}) {}
