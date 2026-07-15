/**
 * multi-tenant-saas-starter
 *
 * A dependency-free, didactic reference for the load-bearing pieces of a B2B
 * multi-tenant SaaS backend. See the README for the architecture overview.
 */

// Tenant context & isolation
export {
  type TenantId,
  type TenantContext,
  type TenantOwned,
  toTenantId,
} from "./tenant/types.js";
export {
  type InboundRequest,
  type Session,
  type SessionStore,
  UnauthenticatedError,
  resolveTenantContext,
} from "./tenant/context.js";
export { TenantScopedRepository } from "./tenant/repository.js";

// Idempotent webhooks
export { verifySignature, signPayload } from "./webhooks/signature.js";
export {
  type PaymentEvent,
  type PaymentEventType,
  parsePaymentEvent,
} from "./webhooks/provider.js";
export {
  type IdempotencyStore,
  type ProcessingState,
  InMemoryIdempotencyStore,
} from "./webhooks/idempotency.js";
export {
  type WebhookResult,
  type EventProcessor,
  type WebhookHandlerOptions,
  WebhookHandler,
} from "./webhooks/handler.js";

// Job queue with DLQ
export {
  type Job,
  type DeadLetter,
  type JobWorker,
  type QueueOptions,
  JobQueue,
} from "./queue/queue.js";
