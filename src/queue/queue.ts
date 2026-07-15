/**
 * A tiny in-memory job queue with retry, exponential backoff, and a
 * dead-letter queue (DLQ).
 *
 * This models the durable-queue pattern without any infrastructure. In
 * production you would replace it with BullMQ (Redis), SQS, or a database-backed
 * queue — but the state machine is the same one this class implements:
 *
 *   enqueue → [attempt] → success            → done
 *                       ↘ failure, attempts left → wait backoff → retry
 *                       ↘ failure, no attempts   → dead-letter queue
 *
 * The DLQ is the part people forget. A job that will never succeed (bad data,
 * a permanent downstream 4xx) must not retry forever; it is parked in the DLQ
 * for a human or a separate process to inspect, fix, and replay. Without a DLQ
 * a single poison message can wedge a whole worker.
 */

export interface Job<T> {
  readonly id: string;
  readonly payload: T;
  attempts: number;
}

export interface DeadLetter<T> {
  readonly job: Job<T>;
  readonly lastError: string;
  readonly failedAt: number;
}

/** Processes a job. Throwing signals failure and triggers retry/DLQ logic. */
export type JobWorker<T> = (payload: T, attempt: number) => Promise<void>;

export interface QueueOptions {
  /** Total attempts before a job is dead-lettered (must be >= 1). */
  readonly maxAttempts: number;
  /** Base delay in ms for exponential backoff: base * 2^(attempt-1). */
  readonly backoffBaseMs: number;
  /**
   * Injectable sleep, defaulting to real time. Tests pass a no-op so backoff
   * doesn't slow the suite; production leaves it as the real timer.
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class JobQueue<T> {
  private readonly pending: Job<T>[] = [];
  private readonly dead: DeadLetter<T>[] = [];
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private seq = 0;

  constructor(options: QueueOptions) {
    if (options.maxAttempts < 1) {
      throw new Error("maxAttempts must be at least 1");
    }
    this.maxAttempts = options.maxAttempts;
    this.backoffBaseMs = options.backoffBaseMs;
    this.sleep = options.sleep ?? realSleep;
  }

  /** Add a job to the back of the queue. Returns its generated id. */
  enqueue(payload: T): string {
    const id = `job_${++this.seq}`;
    this.pending.push({ id, payload, attempts: 0 });
    return id;
  }

  /** Backoff delay before the next attempt (attempt is 1-based). */
  private backoffFor(attempt: number): number {
    return this.backoffBaseMs * 2 ** (attempt - 1);
  }

  /**
   * Drain the queue with the given worker until nothing is left to process,
   * routing exhausted jobs to the DLQ. Returns a summary of what happened.
   */
  async process(worker: JobWorker<T>): Promise<{ processed: number; deadLettered: number }> {
    let processed = 0;
    let deadLettered = 0;

    let job = this.pending.shift();
    while (job !== undefined) {
      job.attempts += 1;
      try {
        await worker(job.payload, job.attempts);
        processed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (job.attempts >= this.maxAttempts) {
          // Out of retries: park it in the DLQ instead of looping forever.
          this.dead.push({ job, lastError: message, failedAt: Date.now() });
          deadLettered += 1;
        } else {
          // Wait, then requeue for another attempt.
          await this.sleep(this.backoffFor(job.attempts));
          this.pending.push(job);
        }
      }
      job = this.pending.shift();
    }

    return { processed, deadLettered };
  }

  /** Read-only view of dead-lettered jobs (for inspection / replay tooling). */
  get deadLetters(): readonly DeadLetter<T>[] {
    return this.dead;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Move a dead-lettered job back onto the queue for another chance, e.g.
   * after the underlying bug or bad data has been fixed. Returns `false` if
   * the id is not in the DLQ.
   */
  replayDeadLetter(jobId: string): boolean {
    const index = this.dead.findIndex((d) => d.job.id === jobId);
    if (index === -1) {
      return false;
    }
    const [entry] = this.dead.splice(index, 1);
    if (entry === undefined) {
      return false;
    }
    this.pending.push({ ...entry.job, attempts: 0 });
    return true;
  }
}
