/**
 * Export tests: CSV escaping and the printable document.
 *
 * These are the parts of exporting that are easy to get subtly wrong and impossible to see in a
 * screenshot — a product named `Sugar, 1kg` must stay one cell, a name containing `<script>` must
 * never become markup, and an empty section must say so instead of printing a table with no rows.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPrintHtml, csvCell, csvFilename, escapeHtml, quantityText, toCsv, withBom, type PrintDocument,
} from "../src/services/report-format.ts";

test("CSV cells are quoted only when they need to be, and embedded quotes are doubled", () => {
  assert.equal(csvCell("Flour"), "Flour");
  assert.equal(csvCell(1200), "1200");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
  assert.equal(csvCell("Sugar, 1kg"), '"Sugar, 1kg"');
  assert.equal(csvCell('Bag "25kg"'), '"Bag ""25kg"""');
  assert.equal(csvCell("line\nbreak"), '"line\nbreak"');
  assert.equal(csvCell(" padded "), '" padded "');
});

test("a whole CSV keeps its header, row order and CRLF endings", () => {
  const csv = toCsv(["Product", "Units", "Revenue"], [["Sugar, 1kg", "2000", 1500], ["Soap", 1000, 800]]);
  assert.equal(csv, 'Product,Units,Revenue\r\n"Sugar, 1kg",2000,1500\r\nSoap,1000,800\r\n');
  assert.equal(withBom(csv).charCodeAt(0), 0xfeff);
});

test("file names are safe slugs with the period start day", () => {
  assert.equal(csvFilename(["Sales", "By product"], "2026-11-01"), "idukaa-sales-by-product-2026-11-01.csv");
  assert.equal(csvFilename(["Stock Movement", "Damage / expiry"], "2026-11-01"), "idukaa-stock-movement-damage-expiry-2026-11-01.csv");
});

test("quantities are shown in selling units without trailing zeros", () => {
  assert.equal(quantityText(2000, "kg"), "2 kg");
  assert.equal(quantityText(2500, "pcs"), "2.5 pcs");
  assert.equal(quantityText(1234, "kg"), "1.234 kg");
  assert.equal(quantityText(0, "pcs"), "0 pcs");
});

test("the print document escapes every user-supplied string", () => {
  assert.equal(escapeHtml(`<img src=x onerror="a">&'`), "&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;");
  const doc: PrintDocument = {
    shop: `Aline's <Shop>`, title: "Sales report", period: "3 November 2026", source: "Saved copy — may be out of date",
    generatedAt: "3 Nov 2026, 15:27", metrics: [{ label: "Net sales", value: "1,800 RWF" }],
    sections: [{
      title: "By product", columns: ["Product", "Revenue"], numeric: [1],
      rows: [["<script>alert(1)</script>", "1,800 RWF"]], empty: "No records",
    }],
    notes: ["Contains local data only — pending sales may not be synchronized."],
  };
  const html = buildPrintHtml(doc);
  assert.ok(!html.includes("<script>alert(1)</script>"), "product names never become markup");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("Aline&#39;s &lt;Shop&gt;"));
  assert.ok(html.includes('class="r">1,800 RWF</td>'), "numeric columns are right aligned");
  assert.ok(html.includes("Saved copy — may be out of date"));
  assert.ok(html.includes("Contains local data only"));
  assert.ok(html.includes("@page { size: A4; margin: 12mm; }"));
});

test("an empty section prints an honest row instead of an empty table", () => {
  const html = buildPrintHtml({
    shop: "Shop", title: "Expenses", period: "Today", source: "This device", generatedAt: "now",
    metrics: [], sections: [{ title: "Expenses", columns: ["Date", "Amount"], rows: [], empty: "No expenses in this period" }], notes: [],
  });
  assert.ok(html.includes("No expenses in this period"));
  assert.ok(!html.includes("<tbody></tbody>"));
});
