import assert from "node:assert/strict";
import { test } from "node:test";

import { WebhookHandler } from "../src/webhooks/handler.js";
import { InMemoryIdempotencyStore } from "../src/webhooks/idempotency.js";
import type { PaymentEvent } from "../src/webhooks/provider.js";
import { signPayload } from "../src/webhooks/signature.js";

const SECRET = "whsec_example_secret";

function eventBody(id: string, type: PaymentEvent["type"] = "payment.succeeded"): string {
  const event: PaymentEvent = {
    id,
    type,
    createdAt: 1_700_000_000_000,
    data: { tenantId: "acme", amountCents: 2500, currency: "usd", reference: "ord_1" },
  };
  return JSON.stringify(event);
}

test("a valid event is processed exactly once even if delivered twice", async () => {
  const store = new InMemoryIdempotencyStore();
  let sideEffects = 0;

  const handler = new WebhookHandler({
    secret: SECRET,
    store,
    process: async () => {
      sideEffects += 1;
    },
  });

  const body = eventBody("evt_1");
  const sig = signPayload(body, SECRET);

  const first = await handler.handle(body, sig);
  const second = await handler.handle(body, sig);

  assert.equal(first.status, "processed");
  assert.equal(second.status, "duplicate");
  assert.equal(sideEffects, 1, "business logic must run only once");
});

test("an event with a bad signature is rejected before any processing", async () => {
  const store = new InMemoryIdempotencyStore();
  let sideEffects = 0;

  const handler = new WebhookHandler({
    secret: SECRET,
    store,
    process: async () => {
      sideEffects += 1;
    },
  });

  const body = eventBody("evt_2");
  const result = await handler.handle(body, "deadbeef");

  assert.equal(result.status, "invalid_signature");
  assert.equal(sideEffects, 0);
  assert.equal(await store.getState("evt_2"), undefined, "no claim on rejected events");
});

test("a signature from the wrong secret is rejected", async () => {
  const store = new InMemoryIdempotencyStore();
  const handler = new WebhookHandler({ secret: SECRET, store, process: async () => {} });

  const body = eventBody("evt_3");
  const wrongSig = signPayload(body, "whsec_a_different_secret");

  const result = await handler.handle(body, wrongSig);
  assert.equal(result.status, "invalid_signature");
});

test("a failed event can be retried, then succeeds and dedupes", async () => {
  const store = new InMemoryIdempotencyStore();
  let attempts = 0;

  const handler = new WebhookHandler({
    secret: SECRET,
    store,
    process: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("downstream unavailable");
      }
    },
  });

  const body = eventBody("evt_4");
  const sig = signPayload(body, SECRET);

  const first = await handler.handle(body, sig);
  assert.equal(first.status, "failed");
  assert.equal(await store.getState("evt_4"), "failed");

  // Provider re-delivers; this time processing succeeds.
  const second = await handler.handle(body, sig);
  assert.equal(second.status, "processed");

  // A third delivery is now a duplicate — no third attempt.
  const third = await handler.handle(body, sig);
  assert.equal(third.status, "duplicate");
  assert.equal(attempts, 2);
});
