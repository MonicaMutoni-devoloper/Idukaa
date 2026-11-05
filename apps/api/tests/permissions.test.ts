/**
 * Role hierarchy over the REAL API surface — no database required.
 *
 * The product rule is absolute: OWNER = ALL MANAGER PERMISSIONS + OWNER-ONLY PERMISSIONS. A manager
 * must never be able to do something the owner cannot. This file proves it two ways, from the code
 * itself rather than from a list somebody has to remember to update:
 *
 *   1. every offline operation type (the sync table) is open to the owner whenever it is open to a
 *      manager — and the owner is open to all of them;
 *   2. every controller route decorated with `manager` also carries `owner`, read through Nest's own
 *      route metadata, so a future `@Roles("manager")` cannot silently lock the owner out;
 *   3. the owner-only controls stay owner-only (they must not leak to managers).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { OP_ROLES, canRunOp } from "../src/sync/op-permissions";

const MANAGER_OPS = Object.entries(OP_ROLES).filter(([, roles]) => roles.includes("manager"));
const ALL_OPS = Object.keys(OP_ROLES) as (keyof typeof OP_ROLES)[];

test("the owner can perform every operation a manager can, and every operation at all", () => {
  for (const [type, roles] of MANAGER_OPS) {
    assert.ok(roles.includes("owner"), `${type} is open to a manager, so it must be open to the owner`);
  }
  for (const type of ALL_OPS) {
    assert.ok(OP_ROLES[type].includes("owner"), `the owner is never locked out of ${type}`);
    assert.equal(canRunOp("owner", type), true, `canRunOp(owner, ${type})`);
  }
});

test("the operations the owner used to be refused are now shared with the manager", () => {
  // These three were manager-only in production: a manager could sell, count stock and request a
  // correction, and the shop owner could do none of them.
  for (const type of ["sale.create", "count.submit", "adjustment.request"] as const) {
    assert.deepEqual(OP_ROLES[type].slice().sort(), ["manager", "owner"], `${type} is open to both roles`);
    assert.equal(canRunOp("manager", type), true);
    assert.equal(canRunOp("owner", type), true);
  }
});

test("an administrator has no shop operations, and no operation is manager-only", () => {
  for (const type of ALL_OPS) assert.equal(canRunOp("system_admin", type), false, `system_admin cannot ${type}`);
  const managerOnly = Object.entries(OP_ROLES).filter(([, r]) => r.length === 1 && r[0] === "manager");
  assert.deepEqual(managerOnly, [], "no operation is reserved for managers");
});

/* --------------------------------------------------------------- HTTP routes (@Roles metadata) */

const CONTROLLERS: Record<string, () => Promise<Record<string, unknown>>> = {
  audits: () => import("../src/audits/audits.controller"),
  admin: () => import("../src/auth/admin.controller"),
  "admin-applications": () => import("../src/onboarding/admin-applications.controller"),
  applications: () => import("../src/onboarding/applications.controller"),
  "staff-invitations": () => import("../src/onboarding/staff-invitations.controller"),
  notifications: () => import("../src/notifications/notifications.controller"),
  purchases: () => import("../src/purchases/purchases.controller"),
  profitability: () => import("../src/reports/profitability.controller"),
  reports: () => import("../src/reports/reports.controller"),
  sales: () => import("../src/sales/sales.controller"),
  shop: () => import("../src/shop/shop.controller"),
  staff: () => import("../src/shop/staff.controller"),
  sync: () => import("../src/sync/sync.controller"),
};

interface Route { owner: string; roles: string[] }

/** Every @Roles decorator in the API, on the class and on each handler, keyed by `Controller.handler`. */
async function allRoutes(): Promise<Route[]> {
  const out: Route[] = [];
  for (const load of Object.values(CONTROLLERS)) {
    const mod = await load();
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value !== "function" || !(value as any).prototype) continue;
      const C = value as any;
      const classRoles = Reflect.getMetadata("roles", C) as string[] | undefined;
      if (classRoles) out.push({ owner: name, roles: classRoles });
      for (const key of Object.getOwnPropertyNames(C.prototype)) {
        if (key === "constructor") continue;
        const roles = Reflect.getMetadata("roles", C.prototype[key]) as string[] | undefined;
        if (roles) out.push({ owner: `${name}.${key}`, roles });
      }
    }
  }
  return out;
}

test("no HTTP route grants the manager something it denies the owner", async () => {
  const routes = await allRoutes();
  assert.ok(routes.length >= 20, `the sweep found the controllers (${routes.length} decorated routes)`);

  const managerRoutes = routes.filter((r) => r.roles.includes("manager"));
  assert.ok(managerRoutes.length >= 10, "manager-facing routes are part of the sweep");
  const offenders = managerRoutes.filter((r) => !r.roles.includes("owner"));
  assert.deepEqual(offenders, [], "a manager-only route would let a manager do what the owner cannot");
});

test("owner-only controls stay closed to managers", async () => {
  const routes = await allRoutes();
  const ownerOnly = routes.filter((r) => r.roles.includes("owner") && !r.roles.includes("manager"));
  assert.ok(ownerOnly.length >= 5, "the owner keeps controls a manager must not have");

  // Named by controller so a rename of a handler cannot quietly drop the protection.
  for (const controller of ["SalesController", "AuditsController", "StaffController", "ShopController"]) {
    assert.ok(
      ownerOnly.some((r) => r.owner.startsWith(`${controller}.`) || r.owner === controller),
      `${controller} must still expose at least one owner-only route`,
    );
  }
  // And nothing that carries `manager` appears in that owner-only set.
  for (const r of ownerOnly) assert.ok(!r.roles.includes("manager"), `${r.owner} is not a manager route`);
});
