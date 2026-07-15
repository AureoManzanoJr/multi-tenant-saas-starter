import type { TenantContext, TenantId, TenantOwned } from "./types.js";

/**
 * A tenant-scoped repository.
 *
 * The whole point of this class is that the tenant filter is applied *for* the
 * caller, in one place, on every read and every write. Application code never
 * writes `where tenantId = ?` by hand — and therefore cannot forget to. A
 * repository instance is bound to exactly one {@link TenantContext}; there is
 * no method that lets you widen the scope.
 *
 * The in-memory `store` here exists only to make the example runnable and
 * testable. In production you would back this with a real database. With
 * Prisma, for instance, each method would delegate to the client while merging
 * `{ tenantId: this.tenant.tenantId }` into the `where` clause:
 *
 * ```ts
 * findById(id) {
 *   return prisma.invoice.findFirst({
 *     where: { id, tenantId: this.tenant.tenantId },
 *   });
 * }
 * ```
 *
 * Even better, Prisma client extensions (or Postgres Row-Level Security) let
 * you enforce this at a layer the application cannot bypass — this class models
 * the same guarantee in plain TypeScript.
 */
export class TenantScopedRepository<T extends TenantOwned> {
  /** Shared table across all tenants; every row carries its `tenantId`. */
  private readonly store: Map<string, T>;
  private readonly tenant: TenantContext;

  constructor(tenant: TenantContext, store: Map<string, T> = new Map()) {
    this.tenant = tenant;
    this.store = store;
  }

  private ownsRow(row: T): boolean {
    return row.tenantId === this.tenant.tenantId;
  }

  /** Insert or replace a row, forcing the owning tenant to the current one. */
  async save(entity: Omit<T, "tenantId"> & Partial<Pick<T, "tenantId">>): Promise<T> {
    // The stored tenantId is always taken from the trusted context, never from
    // the incoming object — a caller cannot smuggle in another tenant's id.
    const row = { ...entity, tenantId: this.tenant.tenantId } as T;
    this.store.set(row.id, row);
    return row;
  }

  /** Return a row only if it belongs to the current tenant. */
  async findById(id: string): Promise<T | undefined> {
    const row = this.store.get(id);
    if (row === undefined || !this.ownsRow(row)) {
      // Cross-tenant reads are indistinguishable from "not found" on purpose:
      // we never leak the existence of another tenant's data.
      return undefined;
    }
    return row;
  }

  /** List every row owned by the current tenant. */
  async findAll(): Promise<T[]> {
    const result: T[] = [];
    for (const row of this.store.values()) {
      if (this.ownsRow(row)) {
        result.push(row);
      }
    }
    return result;
  }

  /** Delete a row only if it belongs to the current tenant. Returns success. */
  async delete(id: string): Promise<boolean> {
    const row = this.store.get(id);
    if (row === undefined || !this.ownsRow(row)) {
      return false;
    }
    return this.store.delete(id);
  }

  /** The tenant this repository is permanently bound to. */
  get boundTenant(): TenantId {
    return this.tenant.tenantId;
  }
}
