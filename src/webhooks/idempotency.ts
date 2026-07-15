/**
 * Idempotency store for webhook processing.
 *
 * Providers guarantee *at-least-once* delivery: the same event can arrive
 * twice (network retries, provider retries after a slow response, replays).
 * If "payment.succeeded" is processed twice you might grant a subscription
 * twice or double-count revenue. The fix is an idempotency key — the provider
 * event id — that we claim before doing any work.
 *
 * `claim(eventId)` is the critical primitive. It must be atomic: two
 * concurrent deliveries of the same event must not both win the claim. In this
 * in-memory version the Map operation is atomic within the single-threaded
 * event loop. In production you would use:
 *
 *  - Postgres: `INSERT ... ON CONFLICT (event_id) DO NOTHING` and check
 *    whether a row was actually inserted, or a unique constraint + catch.
 *  - Redis: `SET key value NX EX <ttl>` and check the reply.
 */

export type ProcessingState = "processing" | "done" | "failed";

interface IdempotencyRecord {
  state: ProcessingState;
  claimedAt: number;
}

export interface IdempotencyStore {
  /**
   * Atomically claim an event id. Returns `true` if THIS call won the claim
   * (the caller should process the event) or `false` if it was already claimed
   * (a duplicate — the caller should skip).
   */
  claim(eventId: string): Promise<boolean>;
  markDone(eventId: string): Promise<void>;
  markFailed(eventId: string): Promise<void>;
  getState(eventId: string): Promise<ProcessingState | undefined>;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  async claim(eventId: string): Promise<boolean> {
    const existing = this.records.get(eventId);
    if (existing !== undefined) {
      // Already seen. If a previous attempt failed we allow a re-claim so the
      // event can be retried; a "processing" or "done" record blocks duplicates.
      if (existing.state === "failed") {
        existing.state = "processing";
        existing.claimedAt = Date.now();
        return true;
      }
      return false;
    }
    this.records.set(eventId, { state: "processing", claimedAt: Date.now() });
    return true;
  }

  async markDone(eventId: string): Promise<void> {
    const record = this.records.get(eventId);
    if (record !== undefined) {
      record.state = "done";
    }
  }

  async markFailed(eventId: string): Promise<void> {
    const record = this.records.get(eventId);
    if (record !== undefined) {
      record.state = "failed";
    }
  }

  async getState(eventId: string): Promise<ProcessingState | undefined> {
    return this.records.get(eventId)?.state;
  }
}
