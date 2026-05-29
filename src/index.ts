import { config } from "./config.js";
import { migrate, closeDb } from "./db.js";
import { buildServer } from "./server.js";
import { startWorker } from "./worker.js";
import { closeQueue } from "./queue.js";

async function main() {
  await migrate();

  const server = buildServer();
  const worker = startWorker();

  await server.listen({ port: config.port, host: "0.0.0.0" });
  server.log.info(`worker started (concurrency=${config.workerConcurrency}), primary=${config.primaryModel}`);

  const shutdown = async () => {
    server.log.info("shutting down");
    await server.close();
    await worker.close();
    await closeQueue();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("failed to start", e);
  process.exit(1);
});
