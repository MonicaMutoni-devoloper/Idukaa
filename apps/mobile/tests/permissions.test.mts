/**
 * The owner's app surface must include everything the manager's does. No browser, no database:
 *   npm run test:roles -w @sms/mobile
 *
 * The production regression this pins: the owner's navigation had no `/sell` entry and the stock
 * count control was rendered only for managers, so the owner — who must be able to do everything a
 * manager can — could neither record a sale from the navigation nor count stock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NAV, allNav, bottomNav } from "../src/navigation.ts";

const hrefs = (role: "owner" | "manager") => allNav(role).map((i) => i.href);

test("every destination a manager has is a destination the owner has", () => {
  const owner = new Set(hrefs("owner"));
  const missing = hrefs("manager").filter((h) => !owner.has(h));
  assert.deepEqual(missing, [], "the owner is never missing a manager destination");
});

test("the owner can reach selling and stock counting from the navigation", () => {
  const owner = hrefs("owner");
  assert.ok(owner.includes("/sell"), "the owner records sales with the same screen a manager uses");
  assert.ok(owner.includes("/stock"), "the owner manages stock");
  // One tap, not a deep link: the phone tab bar must expose selling directly.
  assert.ok(bottomNav("owner").some((i) => i.href === "/sell"), "selling is in the owner's tab bar");
});

test("owner-only destinations stay out of the manager's navigation", () => {
  const manager = hrefs("manager");
  for (const href of ["/approvals", "/team", "/profitability"]) {
    assert.ok(!manager.includes(href), `a manager must not see ${href}`);
  }
  for (const href of ["/approvals", "/team", "/profitability"]) {
    assert.ok(hrefs("owner").includes(href), `the owner keeps ${href}`);
  }
});

test("no destination is listed twice for either role", () => {
  for (const role of ["owner", "manager"] as const) {
    const list = hrefs(role);
    assert.equal(new Set(list).size, list.length, `${role} navigation has no duplicate entries`);
  }
  // Every group entry is well formed, so a missing label cannot render an empty row.
  for (const role of ["owner", "manager"] as const) {
    for (const group of NAV[role]) {
      assert.ok(group.label, `${role} group has a label`);
      for (const item of group.items) assert.ok(item.key, `${role} ${item.href} has a label key`);
    }
  }
});
