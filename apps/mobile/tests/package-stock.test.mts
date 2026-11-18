import { test } from "node:test";
import assert from "node:assert/strict";
import { splitStock } from "../src/services/package-stock.ts";

const bottle = { name: "Bottle", qtyBase: 1 };
const crate = { name: "Crate", qtyBase: 12 };
const carton = { name: "Carton", qtyBase: 24 };
const m = (whole: number) => whole * 1000; // whole bottles -> milli base units

test("75 bottles read as 6 crates and 3 bottles", () => {
  assert.deepEqual(splitStock(m(75), [bottle, crate]), [
    { qty: 6, unit: "Crate" },
    { qty: 3, unit: "Bottle" },
  ]);
});

test("the largest package is used first when several are offered", () => {
  // 73 = 3 x 24 + 1
  assert.deepEqual(splitStock(m(73), [bottle, crate, carton]), [
    { qty: 3, unit: "Carton" },
    { qty: 1, unit: "Bottle" },
  ]);
});

test("an exact multiple shows only packages, with no empty remainder", () => {
  assert.deepEqual(splitStock(m(72), [bottle, crate]), [{ qty: 6, unit: "Crate" }]);
});

test("less than one package falls back to the plain figure", () => {
  // A single part says nothing more than "7 bottles"; the caller keeps its own text.
  assert.deepEqual(splitStock(m(7), [bottle, crate]), []);
  assert.deepEqual(splitStock(m(1), [bottle, crate]), []);
});

test("nothing to divide: no packages, one package, or no base unit", () => {
  assert.deepEqual(splitStock(m(75), []), []);
  assert.deepEqual(splitStock(m(75), [bottle]), []);
  // Crates and cartons only, no single-unit package: a remainder has nowhere honest to go.
  assert.deepEqual(splitStock(m(75), [crate, carton]), []);
});

test("fractional base stock is never rounded into whole crates", () => {
  // 12.5 kg with a 12 kg package would claim "1 crate" and hide the half kilo.
  assert.deepEqual(splitStock(12_500, [{ name: "kg", qtyBase: 1 }, { name: "Bag", qtyBase: 12 }]), []);
});

test("zero and negative stock are out of stock, not a package list", () => {
  assert.deepEqual(splitStock(0, [bottle, crate]), []);
  assert.deepEqual(splitStock(-5_000, [bottle, crate]), []);
});

test("nonsense package factors are ignored rather than thrown on", () => {
  assert.deepEqual(splitStock(m(75), [{ name: "Bottle", qtyBase: 1 }, { name: "Broken", qtyBase: 0 }]), []);
  assert.deepEqual(splitStock(m(75), [{ name: "Bottle", qtyBase: 1 }, { name: "Half", qtyBase: 1.5 }]), []);
});
