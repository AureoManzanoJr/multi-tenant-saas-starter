/**
 * Core tenant primitives.
 *
 * The golden rule of B2B multi-tenancy: a request's tenant is a fact derived
 * from trusted state (a verified session, an authenticated API key), never a
 * value the client asserts. We encode that rule in the type system so that it
 * is hard to get wrong by accident.
 */

/**
 * A branded string for tenant identifiers.
 *
 * Branding prevents an arbitrary `string` (for example a raw value pulled from
 * a request body) from being passed where a *trusted* `TenantId` is required.
 * You can only obtain a `TenantId` through {@link toTenantId}, which is meant
 * to be called from inside your authentication layer.
 */
export type TenantId = string & { readonly __brand: "TenantId" };

/**
 * Wrap a trusted string as a {@link TenantId}.
 *
 * Call this ONLY from code that has already authenticated the caller and
 * resolved which tenant they belong to (session lookup, API-key lookup, etc.).
 * Never call it with a value taken directly from client input.
 */
export function toTenantId(value: string): TenantId {
  if (value.length === 0) {
    throw new Error("TenantId cannot be empty");
  }
  return value as TenantId;
}

/**
 * The resolved, trusted identity of the current request.
 *
 * This object is the single source of truth for "who is asking and on behalf
 * of which tenant". Everything downstream (repositories, jobs, webhooks)
 * scopes its work to `tenantId` from here — not from request parameters.
 */
export interface TenantContext {
  readonly tenantId: TenantId;
  /** The authenticated principal (user id, service account, etc.). */
  readonly principalId: string;
  /** Coarse-grained roles used for authorization decisions. */
  readonly roles: readonly string[];
}

/** Every persisted row in a shared-schema design carries its owning tenant. */
export interface TenantOwned {
  readonly id: string;
  readonly tenantId: TenantId;
}
