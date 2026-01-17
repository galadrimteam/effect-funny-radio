import { GoogleClient } from "@effect/ai-google";
import { Chunk, Config, Data, Effect, Either, Layer, Stream } from "effect";
import { Command } from "@effect/platform";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { NodeHttpClient } from "@effect/platform-node";

// Source : https://gist.github.com/Ezka77/72e8a373b6d5373e4c57d617b3d2202f
const audioUrl =
  "https://stream.radiofrance.fr/franceinfo/franceinfo_hifi.m3u8";

// convert to MP3 16kHz monochannel
const audioStream = Command.make(
  "ffmpeg",
  "-i",
  audioUrl,
  "-f",
  "mp3",
  "-ar",
  "16000",
  "-ac",
  "1",
  "-"
).pipe(Command.stream);

const systemInstruction = `Vous êtes un humoriste de stand-up très sarcastique mais au cœur tendre, qui trouve toujours le bon côté des choses.
Transformez l'extrait audio d'actualité en une version courte, drôle et optimiste (maximum 3 à 6 phrases).
Gardez TOUS les faits importants exacts — n'inventez ni ne mentez jamais.
Rendez-la plus légère, ajoutez des observations pleines d'esprit, un brin de moquerie bienveillante sur la situation ou les politiciens, mais restez respectueux.
Terminez sur une note pleine d'espoir ou ridiculement positive.`;

class NoResultError extends Data.TaggedError("NoResultError")<{}> {}

const generateSarcasticContent = (packet: Uint8Array) =>
  Effect.gen(function* () {
    const googleClient = yield* GoogleClient.GoogleClient;
    const data = Buffer.from(packet).toString("base64");
    yield* Effect.log("Generating content...");
    const contentResponse = yield* googleClient.generateContent({
      model: "gemini-3-flash-preview",
      systemInstruction: { parts: [{ text: systemInstruction }] },
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: 1000,
        candidateCount: 1,
      },
      contents: [
        {
          parts: [{ inlineData: { data, mimeType: "audio/mp3" } }],
        },
      ],
    });

    const result = contentResponse.candidates?.[0]?.content?.parts?.[0]?.text;
    yield* Effect.log(
      `Total tokens used: ${contentResponse.usageMetadata?.totalTokenCount}`
    );
    return yield* Either.fromNullable(result, () => new NoResultError());
  });

const program = Effect.gen(function* () {
  yield* Effect.log("Starting audio stream...");

  // Group audio stream chunks every 10 seconds
  // Using a very large chunk size so it only triggers on time interval
  const chunkedAudioStream = audioStream.pipe(
    Stream.groupedWithin(500, "10 seconds"),
    Stream.map((chunk) => {
      // Calculate total length first for efficient allocation
      const totalLength = Chunk.reduce(
        chunk,
        0,
        (acc, bytes) => acc + bytes.length
      );
      // Create a single Uint8Array with the correct size
      const result = new Uint8Array(totalLength);
      // Copy all bytes into the result array
      let offset = 0;
      for (const bytes of chunk) {
        result.set(bytes, offset);
        offset += bytes.length;
      }
      return result;
    })
  );

  yield* Stream.runForEach(chunkedAudioStream, (packet) =>
    generateSarcasticContent(packet).pipe(
      Effect.andThen((result) => Effect.log(result))
    )
  );
});

const layers = Layer.mergeAll(
  GoogleClient.layerConfig({ apiKey: Config.redacted("GEMINI_API_KEY") }).pipe(
    Layer.provide(NodeHttpClient.layer)
  ),
  BunContext.layer
);

BunRuntime.runMain(program.pipe(Effect.provide(layers)));
