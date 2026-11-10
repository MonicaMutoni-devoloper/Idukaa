import { z } from "zod";

export const Roles = ["owner", "manager", "system_admin"] as const;
export type Role = (typeof Roles)[number];

/** Payment methods the shop records on a sale. Cash is the default for existing clients. */
export const PaymentMethods = ["cash", "momo", "bank", "credit"] as const;
export type PaymentMethod = (typeof PaymentMethods)[number];

const id = z.string().uuid();
const int = z.number().int();
const posInt = int.positive();
const qty = posInt; // milli-units
const iso = z.string().datetime();

export const SaleOp = z.object({
  type: z.literal("sale.create"),
  payload: z.object({
    saleId: id, soldAt: iso, discount: int.nonnegative().default(0), amountPaid: int.nonnegative(),
    paymentMethod: z.enum(PaymentMethods).default("cash"),
    lines: z.array(z.object({
      productId: id,
      // `qty` is always BASE milli-units (what stock is deducted in). `sellingQty` is the
      // natural quantity the cashier entered (milli selling units) when the product sells in a
      // unit other than its base unit; the server verifies qty === toBaseQty(sellingQty).
      qty, unitPrice: int.nonnegative(), sellingQty: qty.optional(),
    })).min(1),
  }),
});
export const PurchaseOp = z.object({
  type: z.literal("purchase.create"),
  payload: z.object({
    purchaseId: id, supplierId: id.nullable(), orderedAt: iso, amountPaid: int.nonnegative(),
    reference: z.string().max(80).optional(), notes: z.string().max(500).optional(),
    // Below-cost lines must carry an explicit, auditable decision by the person recording them.
    belowCostAcknowledged: z.boolean().default(false), belowCostReason: z.string().max(500).optional(),
    lines: z.array(z.object({
      productId: id,
      // `qty` is always BASE milli-units (what the ledger receives). `purchaseQty` is the natural
      // quantity the buyer entered (milli purchase units) when the product is bought in a larger
      // unit; the server verifies qty === toBaseQty(purchaseQty) and that `unitFactor` equals the
      // product's configured units-per-purchase, so a conversion can never be applied one-sidedly.
      qty, unitCost: int.nonnegative(),
      sellingPrice: int.nonnegative().optional(),
      purchaseUnit: z.string().min(1).max(20).optional(),
      unitFactor: posInt.optional(), // base units per purchase unit, e.g. 12 for a carton of 12
      purchaseQty: qty.optional(),
    })).min(1),
    receiveNow: z.boolean().default(false),
  }),
});
export const ReceiptOp = z.object({ // supports partial deliveries against a purchase
  type: z.literal("receipt.create"),
  payload: z.object({
    receiptId: id, purchaseId: id, receivedAt: iso,
    lines: z.array(z.object({ productId: id, qty })).min(1),
  }),
});
export const ExpenseOp = z.object({
  type: z.literal("expense.create"),
  payload: z.object({ expenseId: id, category: z.string().min(1).max(60), amount: posInt, paid: z.boolean(), incurredAt: iso, note: z.string().max(500).optional() }),
});
/** Corrections are additive: the original expense row keeps its history in the audit log. */
export const ExpenseUpdateOp = z.object({
  type: z.literal("expense.update"),
  payload: z.object({
    expenseId: id,
    category: z.string().min(1).max(60).optional(),
    amount: posInt.optional(),
    paid: z.boolean().optional(),
    incurredAt: iso.optional(),
    note: z.string().max(500).nullable().optional(),
  }).refine(v => v.category !== undefined || v.amount !== undefined || v.paid !== undefined || v.incurredAt !== undefined || v.note !== undefined,
    { message: "expense_update_empty" }),
});
export const CountOp = z.object({
  type: z.literal("count.submit"),
  payload: z.object({ countId: id, countedAt: iso, lines: z.array(z.object({ productId: id, counted: int.nonnegative() })).min(1) }),
});
export const AdjustmentOp = z.object({
  type: z.literal("adjustment.request"), // stock loss / correction categories; owner approval posts the movement
  payload: z.object({ adjustmentId: id, productId: id, qty: int.refine(n => n !== 0),
    reason: z.enum(["damage", "expiry", "correction", "supplier_return", "sale_return", "theft", "disposal", "supplier_shortage", "other"]),
    note: z.string().min(3).max(500), refundAmount: int.nonnegative().optional() }).refine(v => v.reason !== "sale_return" || v.refundAmount !== undefined, { message: "refundAmount required for sale_return" }),
});
/**
 * Create a product AND register its initial stock in ONE operation (the Add Product form):
 * `initialQty` (milli-units) + `initialUnitCost` (RWF per unit) are captured together, so a
 * product can never exist with a half-recorded starting stock. Editing an existing product
 * simply omits both — the ledger is never touched by an edit.
 */
export const ProductOp = z.object({
  type: z.literal("product.upsert"),
  payload: z.object({ productId: id, code: z.string().min(1).max(40), barcode: z.string().max(64).nullable().optional(), name: z.string().min(1).max(120), category: z.string().max(60).optional(),
    unit: z.string().min(1).max(20), // BASE inventory unit: the unit every ledger quantity is stored in
    sellingPrice: int.nonnegative(), lowStockThreshold: int.nonnegative(),
    initialQty: int.nonnegative().optional(), initialUnitCost: int.nonnegative().optional(),
    // Unit configuration (all optional; omitted = simple 1:1 setup, and on an EXISTING product the
    // server refuses changes so historical quantities can never be reinterpreted):
    purchaseUnit: z.string().min(1).max(20).optional(),
    sellingUnit: z.string().min(1).max(20).optional(),
    unitsPerPurchase: int.min(1).max(1_000_000).optional(), // BASE units per purchase unit (1 bag = 25 kg -> 25)
    unitsPerSelling: int.min(1).max(1_000_000).optional(),   // BASE units per selling unit
  })
    .refine(v => (v.initialQty === undefined) === (v.initialUnitCost === undefined), { message: "initial_stock_incomplete" })
    .refine(v => (v.unitsPerPurchase ?? 1) === 1 || !!v.purchaseUnit, { message: "purchase_unit_required" })
    .refine(v => (v.unitsPerSelling ?? 1) === 1 || !!v.sellingUnit, { message: "selling_unit_required" }),
});
export const SupplierOp = z.object({
  type: z.literal("supplier.upsert"),
  payload: z.object({ supplierId: id, name: z.string().min(1).max(120), phone: z.string().max(30).optional() }),
});

export const Operation = z.discriminatedUnion("type", [SaleOp, PurchaseOp, ReceiptOp, ExpenseOp, ExpenseUpdateOp, CountOp, AdjustmentOp, ProductOp, SupplierOp]).and(
  z.object({ opId: id, deviceId: z.string().min(1).max(64), createdAt: iso }),
);
export type OperationT = z.infer<typeof Operation>;

export const PushRequest = z.object({ operations: z.array(Operation).min(1).max(100) });
export type OpStatus = "applied" | "duplicate" | "conflict" | "rejected" | "pending_approval";
export interface OpResult { opId: string; status: OpStatus; message?: string; serverRef?: string }
export interface PullResponse {
  checkpoint: string;
  changes: { entity: string; id: string; data: unknown; deleted?: boolean }[];
  hasMore: boolean;
  /** Monotonic per-shop marker for dashboard-visible data; absent from older API builds. */
  revision?: string;
}
