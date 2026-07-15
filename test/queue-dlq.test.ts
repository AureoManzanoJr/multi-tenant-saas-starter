import assert from "node:assert/strict";
import { test } from "node:test";

import { JobQueue } from "../src/queue/queue.js";

// No-op sleep so backoff doesn't slow the suite.
const noSleep = async (): Promise<void> => {};

test("a job that always fails ends up in the DLQ after maxAttempts", async () => {
  const queue = new JobQueue<{ email: string }>({
    maxAttempts: 3,
    backoffBaseMs: 10,
    sleep: noSleep,
  });

  let calls = 0;
  queue.enqueue({ email: "poison@example.com" });

  const summary = await queue.process(async () => {
    calls += 1;
    throw new Error("permanent failure");
  });

  assert.equal(calls, 3, "worker retried up to maxAttempts");
  assert.equal(summary.processed, 0);
  assert.equal(summary.deadLettered, 1);
  assert.equal(queue.deadLetters.length, 1);
  assert.equal(queue.deadLetters[0]?.lastError, "permanent failure");
});

test("a job that fails then succeeds is not dead-lettered", async () => {
  const queue = new JobQueue<number>({ maxAttempts: 5, backoffBaseMs: 5, sleep: noSleep });

  let attempts = 0;
  queue.enqueue(7);

  const summary = await queue.process(async (payload, attempt) => {
    attempts = attempt;
    if (payload === 7 && attempt < 3) {
      throw new Error("transient");
    }
  });

  assert.equal(attempts, 3);
  assert.equal(summary.processed, 1);
  assert.equal(summary.deadLettered, 0);
  assert.equal(queue.deadLetters.length, 0);
});

test("healthy jobs are processed and mixed with a poison one", async () => {
  const queue = new JobQueue<string>({ maxAttempts: 2, backoffBaseMs: 1, sleep: noSleep });

  queue.enqueue("ok-1");
  queue.enqueue("poison");
  queue.enqueue("ok-2");

  const summary = await queue.process(async (payload) => {
    if (payload === "poison") {
      throw new Error("bad payload");
    }
  });

  assert.equal(summary.processed, 2);
  assert.equal(summary.deadLettered, 1);
  assert.equal(queue.pendingCount, 0);
});

test("a dead-lettered job can be replayed after a fix", async () => {
  const queue = new JobQueue<string>({ maxAttempts: 1, backoffBaseMs: 1, sleep: noSleep });

  const jobId = queue.enqueue("fixable");

  // First drain: the bug is present, job dies.
  let bugPresent = true;
  await queue.process(async () => {
    if (bugPresent) {
      throw new Error("bug");
    }
  });
  assert.equal(queue.deadLetters.length, 1);

  // Fix the bug and replay the dead letter.
  bugPresent = false;
  const replayed = queue.replayDeadLetter(jobId);
  assert.equal(replayed, true);
  assert.equal(queue.deadLetters.length, 0);
  assert.equal(queue.pendingCount, 1);

  const summary = await queue.process(async () => {});
  assert.equal(summary.processed, 1);
  assert.equal(summary.deadLettered, 0);
});

test("exponential backoff delays grow per attempt", async () => {
  const delays: number[] = [];
  const queue = new JobQueue<string>({
    maxAttempts: 4,
    backoffBaseMs: 100,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });

  queue.enqueue("x");
  await queue.process(async () => {
    throw new Error("always");
  });

  // Attempts 1,2,3 sleep before retry (attempt 4 dead-letters, no sleep).
  // base * 2^(attempt-1): 100, 200, 400
  assert.deepEqual(delays, [100, 200, 400]);
});
