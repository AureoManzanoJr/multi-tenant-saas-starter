import { type TenantContext, type TenantId, toTenantId } from "./types.js";

/**
 * A minimal, framework-agnostic view of the pieces of an inbound request that
 * we are willing to trust for tenant resolution.
 *
 * Note what is intentionally absent: there is no `tenantId` field taken from a
 * header or body. The resolver derives the tenant from the credential, so the
 * client cannot choose its own tenant by tampering with a header.
 */
export interface InboundRequest {
  /** Opaque bearer token / session cookie value, already extracted. */
  readonly credential: string | undefined;
}

/** A record describing an authenticated session, as your auth store would return it. */
export interface Session {
  readonly principalId: string;
  readonly tenantId: string;
  readonly roles: readonly string[];
}

/** Abstraction over "look up a session from a credential". */
export interface SessionStore {
  resolve(credential: string): Promise<Session | undefined>;
}

/**
 * Raised when a request cannot be associated with a trusted tenant. Map this
 * to HTTP 401 at your transport boundary.
 */
export class UnauthenticatedError extends Error {
  constructor(message = "Request has no valid tenant context") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

/**
 * Derive a {@link TenantContext} from an inbound request.
 *
 * This is the ONLY place tenant identity should enter the system. Because the
 * tenant is read from the resolved {@link Session} and not from the request
 * payload, a caller cannot escalate into another tenant by forging a header
 * such as `x-tenant-id`.
 */
export async function resolveTenantContext(
  request: InboundRequest,
  sessions: SessionStore,
): Promise<TenantContext> {
  const credential = request.credential;
  if (credential === undefined || credential.length === 0) {
    throw new UnauthenticatedError("Missing credential");
  }

  const session = await sessions.resolve(credential);
  if (session === undefined) {
    throw new UnauthenticatedError("Credential did not resolve to a session");
  }

  const tenantId: TenantId = toTenantId(session.tenantId);
  return {
    tenantId,
    principalId: session.principalId,
    roles: session.roles,
  };
}
