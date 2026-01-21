import { Command } from "@effect/platform";
import { Context, Effect, Layer, Option, Ref, Stream } from "effect";

// Audio source configurations
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

// Audio processing constants
export const BYTES_PER_SECOND = 24000 * 2;
export const BATCH_THRESHOLD = Math.floor(BYTES_PER_SECOND / 50);

// Service interface
export class AudioSource extends Context.Tag("AudioSource")<
  AudioSource,
  {
    readonly currentSource: Effect.Effect<Option.Option<AudioSourceId>>;
    readonly setSource: (id: AudioSourceId) => Effect.Effect<void>;
    readonly clearSource: Effect.Effect<void>;
    readonly getStream: () => Stream.Stream<Buffer, Error>;
  }
>() {}

// Batch audio bytes for efficient processing
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

// Create ffmpeg command for audio streaming
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

export const AudioSourceLive = Layer.effect(
  AudioSource,
  Effect.gen(function* () {
    const sourceRef = yield* Ref.make<Option.Option<AudioSourceId>>(
      Option.none()
    );

    return {
      currentSource: Ref.get(sourceRef),
      setSource: (id: AudioSourceId) => Ref.set(sourceRef, Option.some(id)),
      clearSource: Ref.set(sourceRef, Option.none()),
      getStream: () =>
        Stream.unwrap(
          Effect.gen(function* () {
            const maybeSourceId = yield* Ref.get(sourceRef);
            return Option.match(maybeSourceId, {
              onNone: () => Stream.empty,
              onSome: (sourceId) => {
                const url = AUDIO_SOURCES[sourceId].url;
                return Stream.fromEffect(
                  Effect.log(
                    `Starting audio stream from ${AUDIO_SOURCES[sourceId].name}`
                  )
                ).pipe(Stream.flatMap(() => createAudioStream(url)));
              },
            });
          })
        ),
    };
  })
);
