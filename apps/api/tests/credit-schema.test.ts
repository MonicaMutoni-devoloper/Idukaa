/**
 * Database-free checks for the credit sync contract. These do not replace the PostgreSQL
 * integration tests; they pin the client/server boundary that a malformed operation must never
 * cross, even when no test database is available.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID as uuid } from "node:crypto";
import { CreditPaymentOp, SaleOp } from "@sms/shared";
import { OP_ROLES, canRunOp } from "../src/sync/op-permissions";

const payment = (patch: Record<string, unknown> = {}) => ({
  type: "credit.payment.create" as const,
  payload: {
    paymentId: uuid(), customerId: uuid(), amount: 1000,
    paidAt: new Date().toISOString(), method: "cash" as const, reference: "PAY-001",
    ...patch,
  },
});

test("a credit payment requires a positive integer and a reference", () => {
  assert.equal(CreditPaymentOp.safeParse(payment()).success, true);
  for (const amount of [0, -1, 1.5]) {
    assert.equal(CreditPaymentOp.safeParse(payment({ amount })).success, false, `amount ${amount} must be rejected`);
  }
  assert.equal(CreditPaymentOp.safeParse(payment({ reference: "  " })).success, false);
  assert.equal(CreditPaymentOp.safeParse(payment({ method: "credit" })).success, false);
});

test("credit sales carry the customer, due date and an optional audited override", () => {
  const sale = {
    type: "sale.create" as const,
    payload: {
      saleId: uuid(), soldAt: new Date().toISOString(), amountPaid: 0,
      customerId: uuid(), dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      creditOverrideReason: "Owner approved a school account",
      lines: [{ productId: uuid(), qty: 1000, unitPrice: 500 }],
    },
  };
  assert.equal(SaleOp.safeParse(sale).success, true);
  assert.equal(SaleOp.safeParse({ ...sale, payload: { ...sale.payload, customerId: undefined } }).success, true);
  assert.equal(SaleOp.safeParse({ ...sale, payload: { ...sale.payload, creditOverrideReason: "no" } }).success, false);
});

test("repayments are available to both shop roles and never to a platform administrator", () => {
  assert.deepEqual(OP_ROLES["credit.payment.create"].slice().sort(), ["manager", "owner"]);
  assert.equal(canRunOp("owner", "credit.payment.create"), true);
  assert.equal(canRunOp("manager", "credit.payment.create"), true);
  assert.equal(canRunOp("system_admin", "credit.payment.create"), false);
});
