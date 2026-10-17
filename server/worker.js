import { Worker } from "bullmq";
import IORedis from "ioredis";
import { executeCode } from "./executor.js";

const redisConnection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null,
});

redisConnection.on("error", (error) => {
  console.error("Worker Redis error:", error);
});

const worker = new Worker(
  "code-execution",
  async (job) => {
    console.log(`Executing job ${job.id}:`, {
      roomId: job.data.roomId,
      language: job.data.language,
    });

    const result = await executeCode({
      language: job.data.language,
      code: job.data.code,
    });

    return result;
  },
  {
    connection: redisConnection,
    concurrency: 2,
  }
);

worker.on("completed", (job, result) => {
  console.log(`Job ${job.id} completed:`, result);
});

worker.on("failed", (job, error) => {
  console.error(`Job ${job?.id} failed:`, error);
});

worker.on("error", (error) => {
  console.error("BullMQ worker error:", error);
});

async function shutdown() {
  console.log("Stopping worker...");

  await worker.close();
  await redisConnection.quit().catch(() => {});

  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("Execution worker is waiting for jobs");