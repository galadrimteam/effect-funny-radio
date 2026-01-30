import {
  HttpApiBuilder,
  HttpApiScalar,
  HttpMiddleware,
  HttpServer,
} from "@effect/platform";
import { BunContext, BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Config, Effect, Layer, Context } from "effect";
import { AudioSource } from "./AudioSource.js";
import { OpenAIRealtime } from "./OpenAIRealtime.js";
import { runAudioProcessor } from "./AudioProcessor.js";
import { FunnyRadioApiLive } from "./HttpApi.js";

const HttpServerLive = Layer.unwrapEffect(
  Config.port("PORT").pipe(
    Config.withDefault(3000),
    Effect.map((port) => BunHttpServer.layer({ port, idleTimeout: 0 }))
  )
);

const HttpLive = HttpApiBuilder.serve(HttpMiddleware.logger).pipe(
  Layer.provide(HttpApiScalar.layer({ path: "/docs" })),
  Layer.provide(FunnyRadioApiLive),
  HttpServer.withLogAddress,
  Layer.provide(HttpServerLive)
);

const ServicesLive = Layer.mergeAll(
  AudioSource.Default.pipe(Layer.provide(BunContext.layer)),
  OpenAIRealtime.Default
);

const AudioProcessingLive = Layer.scopedDiscard(
  Effect.fork(runAudioProcessor)
);

const AppLive = Layer.merge(HttpLive, AudioProcessingLive).pipe(
  Layer.provide(ServicesLive)
);

BunRuntime.runMain(Layer.launch(AppLive));
