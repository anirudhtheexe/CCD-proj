import { Queue, QueueEvents } from "bullmq";
import IORedis from "ioredis";

export const redisConnection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: 1,
});

redisConnection.on("error", (error) => {
  console.error("Redis connection error:", error);
});

export const executionQueue = new Queue("code-execution", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: {
      age: 60 * 60,
      count: 1000,
    },
    removeOnFail: {
      age: 24 * 60 * 60,
      count: 1000,
    },
  },
});

// QueueEvents needs its own Redis connection.
export const queueEventsConnection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null,
});

queueEventsConnection.on("error", (error) => {
  console.error("Queue events Redis error:", error);
});

export const executionQueueEvents = new QueueEvents("code-execution", {
  connection: queueEventsConnection,
});