export type ServerEvent =
  | { type: "response.output_text.delta"; response_id: string; delta: string }
  | { type: "response.done"; response: { id: string; status: string } }
  | { type: "error"; error: { message: string } };

export type BroadcastMessage =
  | { type: "delta"; responseId: string; text: string }
  | { type: "complete"; responseId: string }
  | { type: "error"; message: string };
