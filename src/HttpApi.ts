import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
  HttpApiSchema,
  HttpServerResponse,
  OpenApi,
} from "@effect/platform";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import {
  AudioSource,
  AUDIO_SOURCES,
  type AudioSourceId,
} from "./AudioSource.js";
import { type BroadcastMessage, OpenAIRealtime } from "./OpenAIRealtime.js";

// Schema for audio source selection
const AudioSourceIdSchema = Schema.Literal(
  "franceinfo",
  "franceinter",
  "franceculture"
).annotations({
  title: "Audio Source ID",
  description: "Identifier for a French radio station",
});

const AudioSourceInfo = Schema.Struct({
  id: AudioSourceIdSchema,
  name: Schema.String.annotations({
    description: "Human-readable station name",
  }),
  url: Schema.String.annotations({ description: "Stream URL" }),
}).annotations({
  title: "Audio Source Info",
  description: "Information about an available audio source",
});

const AudioSourcesResponse = Schema.Struct({
  sources: Schema.Array(AudioSourceInfo).annotations({
    description: "List of all available audio sources",
  }),
  current: Schema.NullOr(AudioSourceIdSchema).annotations({
    description: "Currently selected source, or null if none selected",
  }),
}).annotations({ title: "Audio Sources Response" });

const SetSourceRequest = Schema.Struct({
  source: AudioSourceIdSchema.annotations({
    description: "The audio source to select",
  }),
}).annotations({ title: "Set Source Request" });

const SetSourceResponse = Schema.Struct({
  success: Schema.Boolean,
  current: AudioSourceIdSchema,
  name: Schema.String.annotations({
    description: "Name of the selected source",
  }),
}).annotations({ title: "Set Source Response" });

// Define the API
export class FunnyRadioApi extends HttpApi.make("funnyRadioApi")
  .add(
    HttpApiGroup.make("ui").add(
      HttpApiEndpoint.get("getIndex", "/").addSuccess(
        Schema.String.pipe(
          HttpApiSchema.withEncoding({ kind: "Text", contentType: "text/html" })
        )
      )
    )
  )
  .add(
    HttpApiGroup.make("sources")
      .annotate(OpenApi.Title, "Audio Sources")
      .annotate(
        OpenApi.Description,
        "Manage audio sources for the sarcastic news transformer"
      )
      .add(
        HttpApiEndpoint.get("getSources", "/sources")
          .annotate(OpenApi.Summary, "List available audio sources")
          .addSuccess(AudioSourcesResponse)
          .addError(HttpApiError.InternalServerError)
      )
      .add(
        HttpApiEndpoint.post("setSource", "/sources")
          .annotate(OpenApi.Summary, "Set the audio source")
          .addSuccess(SetSourceResponse)
          .setPayload(SetSourceRequest)
          .addError(HttpApiError.InternalServerError)
      )
  )
  .add(
    HttpApiGroup.make("stream")
      .annotate(OpenApi.Title, "Message Stream")
      .annotate(
        OpenApi.Description,
        "Server-Sent Events stream of transformed audio messages"
      )
      .add(
        HttpApiEndpoint.get("getStream", "/stream")
          .annotate(OpenApi.Summary, "Subscribe to sarcastic messages")
          .addSuccess(
            Schema.String.pipe(
              HttpApiSchema.withEncoding({
                kind: "Text",
                contentType: "text/event-stream",
              })
            )
          )
          .addError(HttpApiError.ServiceUnavailable)
          .addError(HttpApiError.InternalServerError)
      )
  )
  .annotate(OpenApi.Title, "Funny Radio API")
  .annotate(
    OpenApi.Description,
    "Transform French radio news into sarcastic, optimistic summaries using AI"
  )
  .annotate(OpenApi.Version, "1.0.0") {}

const formatSSE = (msg: BroadcastMessage): string =>
  `data: ${JSON.stringify(msg)}\n\n`;

// UI group - serves HTML page
const uiGroupLive = HttpApiBuilder.group(FunnyRadioApi, "ui", (handlers) =>
  handlers.handleRaw("getIndex", () =>
    Effect.gen(function* () {
      const html = yield* Effect.promise(() =>
        Bun.file(import.meta.dir + "/index.html").text()
      );
      return HttpServerResponse.text(html, { contentType: "text/html" });
    })
  )
);

// Sources group
const sourcesGroupLive = HttpApiBuilder.group(
  FunnyRadioApi,
  "sources",
  (handlers) =>
    handlers
      .handle("getSources", () =>
        Effect.gen(function* () {
          const audioSource = yield* AudioSource;
          const maybeCurrent = yield* audioSource.currentSource;
          const sources = Object.entries(AUDIO_SOURCES).map(([id, info]) => ({
            id: id as AudioSourceId,
            name: info.name,
            url: info.url,
          }));
          return { sources, current: Option.getOrNull(maybeCurrent) };
        })
      )
      .handle("setSource", ({ payload }) =>
        Effect.gen(function* () {
          const audioSource = yield* AudioSource;
          yield* audioSource.setSource(payload.source);
          const name = AUDIO_SOURCES[payload.source].name;
          yield* Effect.log(`Audio source changed to: ${name}`);
          return { success: true, current: payload.source, name };
        })
      )
);

// Stream group
const streamGroupLive = HttpApiBuilder.group(
  FunnyRadioApi,
  "stream",
  (handlers) =>
    handlers.handleRaw("getStream", () =>
      Effect.gen(function* () {
        const audioSource = yield* AudioSource;
        const maybeCurrent = yield* audioSource.currentSource;

        if (Option.isNone(maybeCurrent)) {
          return yield* new HttpApiError.ServiceUnavailable();
        }

        const openai = yield* OpenAIRealtime;
        const subscription = yield* openai.subscribe;

        const stream = Stream.fromQueue(subscription).pipe(
          Stream.map((msg) => new TextEncoder().encode(formatSSE(msg)))
        );

        return yield* HttpServerResponse.stream(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            Connection: "keep-alive",
          },
        });
      }).pipe(
        Effect.catchTag(
          "WebSocketError",
          () => new HttpApiError.ServiceUnavailable()
        )
      )
    )
);

export const FunnyRadioApiLive = HttpApiBuilder.api(FunnyRadioApi).pipe(
  Layer.provide(uiGroupLive),
  Layer.provide(sourcesGroupLive),
  Layer.provide(streamGroupLive)
);
