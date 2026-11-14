import { test } from "node:test";
import assert from "node:assert/strict";
import { creditLimitState, creditTotals, validateNewCreditCustomer } from "../src/services/credit-sale.ts";
import { formatRwandaPhone, normalizeRwandaPhone, samePhone } from "@sms/shared";

const jean = [{ id: "c1", phone: "0788123456" }, { id: "c2", phone: null }];

test("a credit customer needs a real name", () => {
  assert.deepEqual(validateNewCreditCustomer({ name: " J ", phone: "0788123456" }, jean),
    { ok: false, reason: "name" });
  assert.deepEqual(validateNewCreditCustomer({ name: "   ", phone: "0788123456" }, jean),
    { ok: false, reason: "name" });
});

test("a credit customer needs a valid Rwandan mobile number", () => {
  for (const phone of ["", "0788", "1234567890", "078812345", "07881234567", "abc"]) {
    assert.deepEqual(validateNewCreditCustomer({ name: "Jean Claude", phone }, jean),
      { ok: false, reason: "phone" }, `${phone} must be refused`);
  }
  assert.deepEqual(validateNewCreditCustomer({ name: "Jean Claude", phone: "0722 000 111" }, jean),
    { ok: true, name: "Jean Claude", phone: "0722000111" });
});

test("one person cannot become two credit accounts, however the phone is written", () => {
  for (const phone of ["0788 123 456", "+250 788 123 456", "250788123456", "(0788) 123-456"]) {
    assert.deepEqual(validateNewCreditCustomer({ name: "Jean Claude", phone }, jean),
      { ok: false, reason: "duplicate", duplicateId: "c1" }, `${phone} must match the stored number`);
  }
});

test("a customer without a phone does not block a different number", () => {
  assert.deepEqual(validateNewCreditCustomer({ name: "Alice", phone: "0722000111" }, jean),
    { ok: true, name: "Alice", phone: "0722000111" });
});

test("full credit adds the whole sale to the account", () => {
  assert.deepEqual(creditTotals({ total: 35000, paid: 0, previousBalance: 10000 }),
    { credit: 35000, previousBalance: 10000, newBalance: 45000 });
});

test("partial payment only adds the unpaid remainder", () => {
  assert.deepEqual(creditTotals({ total: 35000, paid: 20000, previousBalance: 10000 }),
    { credit: 15000, previousBalance: 10000, newBalance: 25000 });
});

test("a fully paid sale creates no debt, even for a customer with a balance", () => {
  assert.deepEqual(creditTotals({ total: 12000, paid: 12000, previousBalance: 5000 }),
    { credit: 0, previousBalance: 5000, newBalance: 5000 });
});

test("a zero limit is no credit line, not an unlimited one", () => {
  assert.equal(creditLimitState({ limit: 0, newBalance: 1 }), "none");
  assert.equal(creditLimitState({ limit: 10000, newBalance: 10000 }), "ok");
  assert.equal(creditLimitState({ limit: 10000, newBalance: 10001 }), "over");
});

test("Rwandan numbers are stored and compared in one shape", () => {
  assert.equal(normalizeRwandaPhone("0788 123 456"), "0788123456");
  assert.equal(normalizeRwandaPhone("+250788123456"), "0788123456");
  assert.equal(normalizeRwandaPhone("00250788123456"), "0788123456");
  assert.equal(normalizeRwandaPhone("0722000111"), "0722000111");
  assert.equal(normalizeRwandaPhone("0788 123 4567"), null);
  assert.equal(normalizeRwandaPhone(null), null);
  assert.equal(samePhone("0788 123 456", "+250 788 123 456"), true);
  assert.equal(samePhone("0788123456", "0788123457"), false);
  assert.equal(samePhone(null, null), false);
  assert.equal(formatRwandaPhone("0788123456"), "0788 123 456");
  assert.equal(formatRwandaPhone(null), "");
});
