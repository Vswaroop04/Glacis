import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://glacis:glacis@localhost:5432/glacis",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",

  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  openaiApiKey: process.env.OPENAI_API_KEY,

  // Tiered model fallback: first attempt is cheap + fast (benchmark: 100% on clean
  // payloads); retries escalate to the most reliable model (benchmark: best on
  // adversarial). Drives down cost without sacrificing the hard-case accuracy.
  primaryModel: process.env.PRIMARY_MODEL ?? "claude-haiku-4-5-20251001",
  fallbackModel: process.env.FALLBACK_MODEL ?? "claude-sonnet-4-6",

  queueName: "normalize",
  maxAttempts: Number(process.env.MAX_ATTEMPTS ?? 3),
  workerConcurrency: Number(process.env.WORKER_CONCURRENCY ?? 8),

  // Below this LLM-reported confidence, the event is flagged for human review.
  reviewConfidenceThreshold: Number(process.env.REVIEW_CONFIDENCE ?? 0.7),
} as const;
