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
import { AudioProcessor } from "./AudioProcessor.js";
import { FunnyRadioApiLive } from "./HttpApi.js";

const ListeningPort = Context.GenericTag<number>("ListeningPort");
const ListeningPortLive = Layer.effect(
  ListeningPort,
  Config.port("PORT").pipe(Config.withDefault(3000))
);

const HttpServerLive = Layer.unwrapEffect(
  ListeningPort.pipe(
    Effect.map((port) => BunHttpServer.layer({ port, idleTimeout: 0 }))
  )
);

const logListeningServer = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  Layer.effectDiscard(
    ListeningPort.pipe(
      Effect.flatMap((port) =>
        Effect.log(
          `Server: http://localhost:${port} | Docs: http://localhost:${port}/docs`
        )
      )
    )
  ).pipe(Layer.provideMerge(layer));

const HttpLive = HttpApiBuilder.serve(HttpMiddleware.logger).pipe(
  Layer.provide(HttpApiScalar.layer({ path: "/docs" })),
  Layer.provide(FunnyRadioApiLive),
  logListeningServer,
  Layer.provide(HttpServerLive),
  Layer.provide(ListeningPortLive)
);

const ServicesLive = Layer.mergeAll(
  AudioSource.Default,
  OpenAIRealtime.Default,
  BunContext.layer
);

const AudioProcessingLive = Layer.scopedDiscard(
  Effect.fork(AudioProcessor.run)
).pipe(Layer.provide(AudioProcessor.Default));

const AppLive = Layer.merge(HttpLive, AudioProcessingLive).pipe(
  Layer.provide(ServicesLive)
);

BunRuntime.runMain(Layer.launch(AppLive));
