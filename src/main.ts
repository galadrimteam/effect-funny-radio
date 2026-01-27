import {
  HttpApiBuilder,
  HttpApiScalar,
  HttpMiddleware,
  HttpServer,
} from "@effect/platform";
import { BunContext, BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Config, Effect, Layer } from "effect";
import { AudioSourceLive } from "./AudioSource.js";
import { OpenAIRealtime } from "./OpenAIRealtime.js";
import { AudioProcessor } from "./AudioProcessor.js";
import { FunnyRadioApiLive } from "./HttpApi.js";

const startAudioProcessing = Effect.gen(function* () {
  yield* Effect.log("Funny Radio - Sarcastic News Transformer");
  const processor = yield* AudioProcessor;
  yield* processor.run;
});

const loadHttpServer = Layer.unwrapEffect(
  Config.port("PORT").pipe(
    Config.withDefault(3000),
    Effect.tap((port) =>
      Effect.log(
        `Server: http://localhost:${port} | Docs: http://localhost:${port}/docs`
      )
    ),
    Effect.map((port) => BunHttpServer.layer({ port, idleTimeout: 0 }))
  )
);

const HttpLive = HttpApiBuilder.serve(HttpMiddleware.logger).pipe(
  Layer.provide(HttpApiScalar.layer({ path: "/docs" })),
  Layer.provide(FunnyRadioApiLive),
  HttpServer.withLogAddress,
  Layer.provide(loadHttpServer)
);

const ServicesLive = Layer.mergeAll(
  AudioSourceLive,
  OpenAIRealtime.Default,
  BunContext.layer
);

const AudioProcessingLive = Layer.scopedDiscard(
  Effect.fork(startAudioProcessing)
).pipe(Layer.provide(AudioProcessor.Default));

const AppLive = Layer.merge(HttpLive, AudioProcessingLive).pipe(
  Layer.provide(ServicesLive)
);

BunRuntime.runMain(Layer.launch(AppLive));
