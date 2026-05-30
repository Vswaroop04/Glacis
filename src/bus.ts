import { EventEmitter } from "node:events";

// In-process pub/sub so the worker can tell the SSE endpoint when a webhook
// moves through the pipeline. Server and worker run in the same process here;
// in a split deployment this becomes a Redis pub/sub channel.

export interface PipelineEvent {
  type: "accepted" | "processed" | "failed";
  rawEventId: string;
  at: string;
  eventType?: string;
  mode?: string;
  entityId?: string | null;
  state?: string | null;
  confidence?: number | null;
  needsReview?: boolean;
  isException?: boolean;
  exceptionReason?: string | null;
  enrichmentStatus?: string;
  model?: string;
  error?: string;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(0); // many SSE clients may subscribe

export function publish(event: PipelineEvent): void {
  emitter.emit("event", event);
}

export function subscribe(listener: (event: PipelineEvent) => void): () => void {
  emitter.on("event", listener);
  return () => emitter.off("event", listener);
}
