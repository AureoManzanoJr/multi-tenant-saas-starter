# multi-tenant-saas-starter

![CI](https://github.com/AureoManzanoJr/multi-tenant-saas-starter/actions/workflows/ci.yml/badge.svg)

A small, **dependency-free**, didactic TypeScript reference for the three pieces
of a B2B multi-tenant SaaS backend that are easy to get subtly, dangerously
wrong:

1. **Tenant isolation** — deriving the current tenant from trusted state and
   scoping every query to it.
2. **Idempotent webhooks** — verifying signatures and processing each provider
   event *exactly once*.
3. **A durable job queue with a dead-letter queue (DLQ)** — retry with backoff,
   and a safe home for jobs that will never succeed.

It is deliberately **not a framework and not a product**. Everything is backed
by in-memory stores so the whole thing runs and tests in milliseconds with no
database, no Redis, and no cloud account. Each module documents how it maps onto
real infrastructure (Prisma / Postgres RLS, BullMQ, a real PSP) in production.

> This repository is original teaching code. It contains no proprietary logic,
> customer data, or secrets — the example secrets in the tests are literals used
> only to exercise the HMAC path.

---

## Why multi-tenancy is hard

In a B2B SaaS, one deployment serves many customer organizations ("tenants")
out of shared tables. The failure mode is not "the app is slow" — it is
**tenant A reading or mutating tenant B's data**. That is a breach, not a bug.

Three traps account for most of these incidents:

- **Trusting client input for identity.** If the tenant is read from an
  `x-tenant-id` header or a request body field, any caller can set it to
  someone else's id. Tenant must be *derived* from an authenticated credential.
- **Forgetting the filter.** With a shared schema, every single query needs
  `WHERE tenant_id = ?`. One handler that forgets it leaks the whole table.
  The fix is to make the filter impossible to forget — apply it in one place.
- **Duplicate side effects.** Webhooks and jobs are delivered *at least once*.
  Processing "payment succeeded" twice double-charges or double-provisions.
  Exactly-once has to be engineered; it is never free.

This starter shows one clean, testable answer to each.

---

## Architecture

```
                         inbound request (HTTP, webhook, job)
                                        |
                                        v
        +------------------------------------------------------------+
        |  1. TENANT CONTEXT                                          |
        |  resolveTenantContext(request, sessionStore)               |
        |    - credential -> Session -> TenantId (branded type)      |
        |    - client CANNOT assert its own tenant                   |
        +------------------------------------------------------------+
                                        |
                    TenantContext { tenantId, principalId, roles }
                                        |
                                        v
        +------------------------------------------------------------+
        |  2. TENANT-SCOPED REPOSITORY                               |
        |  new TenantScopedRepository<T>(ctx)                        |
        |    - every read/write injects tenantId automatically      |
        |    - cross-tenant access == "not found"                   |
        |    - maps to Prisma where-clause / Postgres RLS           |
        +------------------------------------------------------------+


        webhook delivery (at least once)
                |
                v
        +------------------------------------------------------------+
        |  3. IDEMPOTENT WEBHOOK HANDLER                             |
        |  verify HMAC (timing-safe)  ->  claim event id  ->  run    |
        |         |                              |            |      |
        |   invalid_signature              duplicate       process   |
        |                                                    -> done  |
        |                                                    -> failed (retryable)
        +------------------------------------------------------------+


        background work
                |
                v
        +------------------------------------------------------------+
        |  4. JOB QUEUE + DLQ                                        |
        |  enqueue -> attempt -> success                            |
        |                     -> fail, retries left -> backoff, retry|
        |                     -> fail, exhausted    -> dead-letter   |
        |  replayDeadLetter(id) after a fix                         |
        +------------------------------------------------------------+
```

---

## What each module demonstrates

### 1. Tenant context (`src/tenant/`)

- `TenantId` is a **branded string** — you can only mint one via `toTenantId`,
  which is meant to be called from your auth layer, never from request parsing.
- `resolveTenantContext` derives the tenant from a resolved `Session`. There is
  no code path that lets the client choose its tenant.
- `TenantScopedRepository<T>` is bound to one `TenantContext` at construction.
  Every `save`/`findById`/`findAll`/`delete` applies the tenant filter for you,
  and `save` overwrites any `tenantId` on the incoming object with the trusted
  one — so a caller can't smuggle a row into another tenant.

### 2. Idempotent webhooks (`src/webhooks/`)

- `verifySignature` uses HMAC-SHA256 with a **timing-safe** comparison
  (`crypto.timingSafeEqual`), guarding against length mismatch first.
- `InMemoryIdempotencyStore.claim(eventId)` is the exactly-once primitive:
  the first caller wins, duplicates are told to skip. The comments show the
  Postgres (`INSERT ... ON CONFLICT DO NOTHING`) and Redis (`SET NX`) equivalents.
- `WebhookHandler` orders the defenses correctly: **verify -> claim -> process**,
  recording success/failure so failed events can be retried while succeeded ones
  stay deduplicated.

### 3. Job queue with DLQ (`src/queue/`)

- `JobQueue<T>` retries with **exponential backoff** and moves exhausted jobs to
  a **dead-letter queue** instead of looping forever on a poison message.
- `replayDeadLetter(id)` puts a parked job back after the underlying bug or bad
  data is fixed — the operational escape hatch every real queue needs.
- `sleep` is injectable so tests run instantly; in production this is BullMQ /
  SQS / a database-backed queue with the same state machine.

### 4. Tenant isolation tests (`test/tenant-isolation.test.ts`)

The most important tests in the repo. They put two tenants in **one shared
table** and prove that neither can read, list, or delete the other's rows, and
that identity always comes from the session — not from client input.

---

## Usage

Requires Node.js >= 20.

```bash
npm install      # installs only devDeps: typescript, tsx, @types/node
npm run typecheck
npm test
npm run check    # typecheck + test
```

A minimal end-to-end sketch:

```ts
import {
  resolveTenantContext,
  TenantScopedRepository,
  WebhookHandler,
  InMemoryIdempotencyStore,
  JobQueue,
} from "multi-tenant-saas-starter";

// 1. Derive the tenant from a trusted credential.
const ctx = await resolveTenantContext({ credential: token }, sessionStore);

// 2. All data access is automatically scoped to ctx.tenantId.
const invoices = new TenantScopedRepository(ctx);
await invoices.save({ id: "inv_1", amountCents: 5000 });

// 3. Handle a provider webhook exactly once.
const webhooks = new WebhookHandler({
  secret: process.env.WEBHOOK_SECRET!,
  store: new InMemoryIdempotencyStore(),
  process: async (event) => { /* grant access, record payment, ... */ },
});
const result = await webhooks.handle(rawBody, signatureHeader);

// 4. Run background work with retry + DLQ.
const queue = new JobQueue<{ userId: string }>({ maxAttempts: 5, backoffBaseMs: 250 });
queue.enqueue({ userId: "u_1" });
await queue.process(async (payload) => { /* send email, sync CRM, ... */ });
```

---

## Limitations (by design)

This is a **reference**, not a production library. In particular:

- **In-memory stores** — nothing is persisted. Real deployments use a database
  and Redis. Each module notes the mapping.
- **Idempotency records never expire.** A real store needs a TTL / retention
  policy so it doesn't grow forever.
- **The queue is single-process and in-memory.** No concurrency control, no
  visibility timeout, no persistence across restarts. Use BullMQ/SQS for that.
- **Webhook parsing is minimal.** Production code should validate the full event
  shape (e.g. with `zod`) and enforce a timestamp tolerance to resist replays.
- **No transport layer.** There is no HTTP server here on purpose; wire these
  building blocks into Express/Fastify/Next.js route handlers yourself.

The goal is to make the *shape* of each guarantee obvious and testable, so the
patterns transfer cleanly to whatever stack you actually ship on.

---

## License

MIT © 2026 Aureo Manzano Junior. See [LICENSE](./LICENSE).
