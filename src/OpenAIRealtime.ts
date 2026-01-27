import {
  Config,
  Data,
  Effect,
  Match,
  Queue,
  Redacted,
  Schedule,
  Stream,
  PubSub,
  Ref,
  Scope,
} from "effect";

const OPENAI_URL = "wss://api.openai.com/v1/realtime?model=gpt-realtime-mini";

const systemInstruction = `Vous etes un humoriste de stand-up tres sarcastique mais au coeur tendre, qui trouve toujours le bon cote des choses.
Transformez l'extrait audio d'actualite en une version courte, drole et optimiste (maximum 3 a 6 phrases).
Gardez TOUS les faits importants exacts - n'inventez ni ne mentez jamais.
Rendez-la plus legere, ajoutez des observations pleines d'esprit, un brin de moquerie bienveillante sur la situation ou les politiciens, mais restez respectueux.
Terminez sur une note pleine d'espoir ou ridiculement positive.`;

const sessionUpdateMessage = `{"type":"session.update","session":{"type":"realtime","audio":{"input":{"format":{"type":"audio/pcm","rate":24000},"turn_detection":null,"noise_reduction":null}},"instructions":"${systemInstruction}","model":"gpt-realtime-mini","output_modalities":["text"],"tracing":"auto"}}`;

export type ServerEvent =
  | { type: "response.output_text.delta"; response_id: string; delta: string }
  | { type: "response.done"; response: { id: string; status: string } }
  | { type: "error"; error: { message: string } };

export type BroadcastMessage =
  | { type: "delta"; responseId: string; text: string }
  | { type: "complete"; responseId: string }
  | { type: "error"; message: string };

class WebSocketError extends Data.TaggedError("WebSocketError")<{
  cause: unknown;
}> {}

type Connection = {
  ws: WebSocket;
  pubsub: PubSub.PubSub<BroadcastMessage>;
};

export class OpenAIRealtime extends Effect.Service<OpenAIRealtime>()(
  "OpenAIRealtime",
  {
    effect: Effect.gen(function* () {
      const apiKey = yield* Config.redacted("OPENAI_API_KEY");
      const connectionRef = yield* Ref.make<Connection | null>(null);
      const scope = yield* Scope.make();

      const connect = Effect.gen(function* () {
        const existing = yield* Ref.get(connectionRef);
        if (existing) return existing;

        yield* Effect.log("Connecting to OpenAI Realtime API...");

        const incomingQueue = yield* Queue.unbounded<ServerEvent>();
        const broadcastPubSub = yield* PubSub.unbounded<BroadcastMessage>();

        const connectWithRetry = Effect.async<WebSocket, WebSocketError>(
          (resume) => {
            const ws = new WebSocket(OPENAI_URL, {
              headers: { Authorization: `Bearer ${Redacted.value(apiKey)}` },
            });
            ws.addEventListener("open", () => resume(Effect.succeed(ws)));
            ws.addEventListener("error", (e) =>
              resume(Effect.fail(new WebSocketError({ cause: e })))
            );
          }
        ).pipe(
          Effect.retry(
            Schedule.exponential("1 second").pipe(
              Schedule.compose(Schedule.recurs(5)),
              Schedule.tapOutput((d) =>
                Effect.log(`WebSocket connection failed, retrying in ${d}`)
              )
            )
          )
        );

        const ws = yield* Effect.acquireRelease(connectWithRetry, (ws) =>
          Effect.sync(() => ws.close()).pipe(
            Effect.tap(() => Queue.shutdown(incomingQueue)),
            Effect.tap(() => PubSub.shutdown(broadcastPubSub)),
            Effect.tap(() => Ref.set(connectionRef, null))
          )
        ).pipe(Scope.extend(scope));

        ws.addEventListener("message", (e) => {
          try {
            Queue.unsafeOffer(incomingQueue, JSON.parse(e.data as string));
          } catch {}
        });

        ws.send(sessionUpdateMessage);

        yield* Effect.log("Connected to OpenAI Realtime API");

        const handleMessage = Match.type<ServerEvent>().pipe(
          Match.when({ type: "response.output_text.delta" }, (msg) =>
            PubSub.publish(broadcastPubSub, {
              type: "delta",
              responseId: msg.response_id,
              text: msg.delta,
            })
          ),
          Match.when({ type: "response.done" }, (msg) =>
            PubSub.publish(broadcastPubSub, {
              type: "complete",
              responseId: msg.response.id,
            })
          ),
          Match.when({ type: "error" }, (msg) =>
            Effect.gen(function* () {
              yield* Effect.logError(`OpenAI error: ${msg.error.message}`);
              yield* PubSub.publish(broadcastPubSub, {
                type: "error",
                message: msg.error.message,
              });
            })
          ),
          Match.orElse(() => Effect.void)
        );

        yield* Effect.fork(
          Stream.fromQueue(incomingQueue).pipe(Stream.runForEach(handleMessage))
        );

        const connection: Connection = { ws, pubsub: broadcastPubSub };
        yield* Ref.set(connectionRef, connection);
        return connection;
      });

      return {
        send: (msg: string) =>
          connect.pipe(
            Effect.flatMap((c) => Effect.sync(() => c.ws.send(msg)))
          ),
        subscribe: connect.pipe(
          Effect.flatMap((c) => PubSub.subscribe(c.pubsub))
        ),
      } as const;
    }),
  }
) {}
