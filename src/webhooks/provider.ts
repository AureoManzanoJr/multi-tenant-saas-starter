/**
 * A fictional payment provider, standing in for the shape of a real one
 * (Stripe, Adyen, a PSP, etc.) without depending on any of them.
 *
 * Every real provider webhook shares the same anatomy: a stable unique event
 * id, an event type, a timestamp, and a JSON body. The unique id is what makes
 * exactly-once processing possible — see {@link ../webhooks/idempotency}.
 */

export type PaymentEventType =
  | "payment.succeeded"
  | "payment.failed"
  | "refund.created";

export interface PaymentEvent {
  /** Provider-assigned, globally unique, stable across re-deliveries. */
  readonly id: string;
  readonly type: PaymentEventType;
  /** Unix epoch milliseconds when the provider emitted the event. */
  readonly createdAt: number;
  readonly data: {
    /** The tenant this event concerns, mapped from the provider's account. */
    readonly tenantId: string;
    readonly amountCents: number;
    readonly currency: string;
    readonly reference: string;
  };
}

/** Parse and minimally validate a raw webhook body into a {@link PaymentEvent}. */
export function parsePaymentEvent(rawBody: string): PaymentEvent {
  const parsed: unknown = JSON.parse(rawBody);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Webhook body is not an object");
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj["id"] !== "string" || obj["id"].length === 0) {
    throw new Error("Webhook event is missing a valid id");
  }
  if (typeof obj["type"] !== "string") {
    throw new Error("Webhook event is missing a type");
  }
  // A production parser would validate the full shape (e.g. with zod). We keep
  // it lightweight here and trust the structure for the sake of the example.
  return parsed as PaymentEvent;
}
