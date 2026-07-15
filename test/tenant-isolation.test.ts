import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveTenantContext,
  UnauthenticatedError,
  type Session,
  type SessionStore,
} from "../src/tenant/context.js";
import { TenantScopedRepository } from "../src/tenant/repository.js";
import { toTenantId, type TenantContext, type TenantOwned } from "../src/tenant/types.js";

interface Invoice extends TenantOwned {
  readonly id: string;
  readonly tenantId: ReturnType<typeof toTenantId>;
  readonly amountCents: number;
}

function contextFor(tenant: string, principal = "user_1"): TenantContext {
  return {
    tenantId: toTenantId(tenant),
    principalId: principal,
    roles: ["member"],
  };
}

test("a tenant cannot read another tenant's row by id", async () => {
  // Shared table, two tenants writing into it.
  const table = new Map<string, Invoice>();
  const acme = new TenantScopedRepository<Invoice>(contextFor("acme"), table);
  const globex = new TenantScopedRepository<Invoice>(contextFor("globex"), table);

  await acme.save({ id: "inv_1", amountCents: 5000 });

  // Globex knows the id but must not be able to read it.
  const leaked = await globex.findById("inv_1");
  assert.equal(leaked, undefined, "cross-tenant read must look like not-found");

  // The owning tenant still sees it.
  const owned = await acme.findById("inv_1");
  assert.equal(owned?.amountCents, 5000);
});

test("findAll only returns the current tenant's rows from a shared table", async () => {
  const table = new Map<string, Invoice>();
  const acme = new TenantScopedRepository<Invoice>(contextFor("acme"), table);
  const globex = new TenantScopedRepository<Invoice>(contextFor("globex"), table);

  await acme.save({ id: "a1", amountCents: 100 });
  await acme.save({ id: "a2", amountCents: 200 });
  await globex.save({ id: "g1", amountCents: 999 });

  const acmeRows = await acme.findAll();
  assert.equal(acmeRows.length, 2);
  assert.ok(acmeRows.every((r) => r.tenantId === toTenantId("acme")));

  const globexRows = await globex.findAll();
  assert.equal(globexRows.length, 1);
  assert.equal(globexRows[0]?.id, "g1");
});

test("a tenant cannot delete another tenant's row", async () => {
  const table = new Map<string, Invoice>();
  const acme = new TenantScopedRepository<Invoice>(contextFor("acme"), table);
  const globex = new TenantScopedRepository<Invoice>(contextFor("globex"), table);

  await acme.save({ id: "inv_9", amountCents: 4200 });

  const deleted = await globex.delete("inv_9");
  assert.equal(deleted, false, "cross-tenant delete must be refused");
  assert.ok(await acme.findById("inv_9"), "row must still exist for its owner");
});

test("save cannot smuggle a foreign tenantId into a row", async () => {
  const table = new Map<string, Invoice>();
  const acme = new TenantScopedRepository<Invoice>(contextFor("acme"), table);

  // Caller attempts to write a row owned by "globex" while scoped to "acme".
  await acme.save({ id: "inv_x", amountCents: 1, tenantId: toTenantId("globex") });

  const stored = table.get("inv_x");
  assert.equal(
    stored?.tenantId,
    toTenantId("acme"),
    "stored tenantId must come from the trusted context, not the payload",
  );
});

test("tenant is derived from the session, never from client-supplied input", async () => {
  const sessions: SessionStore = {
    async resolve(credential: string): Promise<Session | undefined> {
      if (credential === "valid-token") {
        return { principalId: "user_42", tenantId: "acme", roles: ["admin"] };
      }
      return undefined;
    },
  };

  const ctx = await resolveTenantContext({ credential: "valid-token" }, sessions);
  assert.equal(ctx.tenantId, toTenantId("acme"));
  assert.equal(ctx.principalId, "user_42");

  // No credential -> unauthenticated.
  await assert.rejects(
    resolveTenantContext({ credential: undefined }, sessions),
    UnauthenticatedError,
  );

  // Unknown credential -> unauthenticated (cannot self-assign a tenant).
  await assert.rejects(
    resolveTenantContext({ credential: "forged" }, sessions),
    UnauthenticatedError,
  );
});
