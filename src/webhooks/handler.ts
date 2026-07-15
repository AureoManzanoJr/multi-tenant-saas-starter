import type { IdempotencyStore } from "./idempotency.js";
import { parsePaymentEvent, type PaymentEvent } from "./provider.js";
import { verifySignature } from "./signature.js";

/** Outcome of feeding a raw webhook through {@link WebhookHandler.handle}. */
export type WebhookResult =
  | { status: "processed"; event: PaymentEvent }
  | { status: "duplicate"; eventId: string }
  | { status: "invalid_signature" }
  | { status: "failed"; eventId: string; error: string };

/** Business logic to run for a verified, first-seen event. */
export type EventProcessor = (event: PaymentEvent) => Promise<void>;

export interface WebhookHandlerOptions {
  readonly secret: string;
  readonly store: IdempotencyStore;
  readonly process: EventProcessor;
}

/**
 * An idempotent webhook handler that ties the three defenses together:
 *
 *   1. Authenticate  — HMAC signature verification (timing-safe).
 *   2. Deduplicate   — claim the event id before doing any work.
 *   3. Process       — run business logic exactly once; record the outcome.
 *
 * The ordering matters. We verify the signature FIRST so an unauthenticated
 * caller can never even reach the idempotency store, and we claim the id
 * BEFORE processing so a duplicate that arrives mid-flight is rejected.
 */
export class WebhookHandler {
  private readonly secret: string;
  private readonly store: IdempotencyStore;
  private readonly process: EventProcessor;

  constructor(options: WebhookHandlerOptions) {
    this.secret = options.secret;
    this.store = options.store;
    this.process = options.process;
  }

  async handle(rawBody: string, signature: string): Promise<WebhookResult> {
    // 1. Authenticate. Verify against the RAW body — never a re-serialized
    //    object, whose byte layout may differ from what the provider signed.
    if (!verifySignature(rawBody, signature, this.secret)) {
      return { status: "invalid_signature" };
    }

    const event = parsePaymentEvent(rawBody);

    // 2. Deduplicate. Whoever wins the claim owns processing this event.
    const won = await this.store.claim(event.id);
    if (!won) {
      return { status: "duplicate", eventId: event.id };
    }

    // 3. Process, recording success or failure so a failed event can be retried
    //    while a succeeded one stays deduplicated forever.
    try {
      await this.process(event);
      await this.store.markDone(event.id);
      return { status: "processed", event };
    } catch (error) {
      await this.store.markFailed(event.id);
      const message = error instanceof Error ? error.message : String(error);
      return { status: "failed", eventId: event.id, error: message };
    }
  }
}
