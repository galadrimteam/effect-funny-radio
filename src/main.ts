import {
  HttpApiBuilder,
  HttpApiScalar,
  HttpMiddleware,
  HttpServer,
} from "@effect/platform";
import { BunContext, BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { AudioSourceLive } from "./AudioSource.js";
import { OpenAIRealtimeLive } from "./OpenAIRealtime.js";
import { AudioProcessor, AudioProcessorLive } from "./AudioProcessor.js";
import { FunnyRadioApiLive } from "./HttpApi.js";

const PORT = Number(process.env.PORT) || 3000;

// Audio processing effect - starts the processor that feeds audio to OpenAI
const startAudioProcessing = Effect.gen(function* () {
  yield* Effect.log("Funny Radio - Sarcastic News Transformer");
  yield* Effect.log(`Server running at http://localhost:${PORT}`);
  yield* Effect.log("Endpoints:");
  yield* Effect.log("  GET  /sources  - List available audio sources");
  yield* Effect.log("  POST /sources  - Set audio source");
  yield* Effect.log("  GET  /stream   - SSE stream of sarcastic messages");
  yield* Effect.log("  GET  /docs     - Swagger API documentation");

  const processor = yield* AudioProcessor;
  yield* processor.run;
});

// Layer that runs audio processing as a background service
const AudioProcessingLive = Layer.scopedDiscard(
  Effect.fork(startAudioProcessing)
);

// HTTP server layer with Swagger documentation
const HttpLive = HttpApiBuilder.serve(HttpMiddleware.logger).pipe(
  Layer.provide(HttpApiScalar.layer({ path: "/docs" })),
  Layer.provide(FunnyRadioApiLive),
  HttpServer.withLogAddress,
  Layer.provide(BunHttpServer.layer({ port: PORT, idleTimeout: 0 }))
);

// Services layer - shared across HTTP and audio processing
const ServicesLive = Layer.mergeAll(
  AudioSourceLive,
  AudioProcessorLive,
  BunContext.layer
).pipe(Layer.provideMerge(OpenAIRealtimeLive));

// Complete application: HTTP server + audio processing, sharing services
const AppLive = Layer.merge(HttpLive, AudioProcessingLive).pipe(
  Layer.provide(ServicesLive)
);

// Launch the application
Layer.launch(AppLive).pipe(BunRuntime.runMain);
