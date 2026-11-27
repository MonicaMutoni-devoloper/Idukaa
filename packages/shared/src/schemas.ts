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
    /** Optional customer account. Required when any part of the sale is unpaid. */
    customerId: id.nullable().optional(), dueAt: iso.optional(),
    /** Explicit, auditable owner decision when a credit limit is exceeded. */
    creditOverrideReason: z.string().trim().min(3).max(500).optional(),
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
/**
 * A customer registered at the counter, so a credit sale can name who took the goods even with no
 * connection. The phone is what identifies the debtor, so it is required and normalised before it
 * is stored; one phone per shop keeps a single credit account per person.
 */
export const CustomerOp = z.object({
  type: z.literal("customer.upsert"),
  payload: z.object({
    customerId: id,
    name: z.string().trim().min(2).max(120),
    phone: z.string().trim().min(7).max(30),
    address: z.string().trim().max(240).optional(),
    /** Only an owner's value is stored: a manager cannot open a credit line. */
    creditLimit: int.nonnegative().optional(),
  }),
});
/** A repayment against a customer's credit account. One operation = one idempotent payment. */
export const CreditPaymentOp = z.object({
  type: z.literal("credit.payment.create"),
  payload: z.object({
    paymentId: id, customerId: id, amount: posInt, paidAt: iso,
    method: z.enum(["cash", "momo", "bank"]), reference: z.string().trim().min(3).max(80),
  }),
});

/**
 * An alert investigation step recorded while the device had no connection. It carries the
 * `updatedAt` the reviewer was looking at, so the server can refuse to apply a decision to an alert
 * that changed on another device in the meantime instead of silently overwriting it. The operation
 * id makes a replayed batch harmless: the same decision is applied at most once.
 */
export const AlertActionOp = z.object({
  type: z.literal("alert.action"),
  payload: z.object({
    alertId: id,
    action: z.enum(["investigate", "assign", "note", "escalate", "resolve", "reopen"]),
    note: z.string().trim().min(3).max(2000),
    /** The alert version this decision was made against; null only for legacy queues. */
    expectedUpdatedAt: iso.nullable().optional(),
    assignedTo: id.nullable().optional(),
    category: z.enum(["approved_activity", "human_error", "suspicious_activity", "false_positive", "other"]).nullable().optional(),
    correctiveAction: z.string().trim().max(1000).nullable().optional(),
    escalateTo: id.nullable().optional(),
    approvedBy: id.nullable().optional(),
  }),
});

/**
 * Returning goods from a completed sale. Lines carry only the quantity and the condition: the
 * refund and the original cost are read from the sale on the server, so a device (or a tampered
 * request) can never refund more than was charged or reverse a cost the sale never carried.
 */
export const ReturnOp = z.object({
  type: z.literal("sale.return"),
  payload: z.object({
    returnId: id, saleId: id, returnedAt: iso,
    reason: z.string().trim().min(3).max(500),
    note: z.string().trim().max(1000).optional(),
    /** Owner authorisation when the shop policy requires it (dispatched goods, damaged concession). */
    approvalRef: z.string().trim().max(120).optional(),
    lines: z.array(z.object({
      productId: id, qty,
      condition: z.enum(["resalable", "damaged", "expired", "inspection"]),
    })).min(1).max(100),
  }),
});

/**
 * A request to correct a posted sale. It is deliberately only a REQUEST: a manager can record it
 * offline, but it has no stock, money or report effect until an owner approves it online. The
 * original sale is never included as mutable data; `saleId` is only a reference and the server
 * takes its own immutable snapshot.
 */
export const CorrectionRequestOp = z.object({
  type: z.literal("correction.request"),
  payload: z.object({
    correctionId: id,
    saleId: id,
    reason: z.string().trim().min(3).max(1000),
    /** Text evidence/reference from the existing investigation; this app has no file attachments. */
    evidence: z.string().trim().max(4000).optional(),
    /** Whether the goods are still in the shop or have already been handed to the customer. */
    fulfillment: z.enum(["not_handed_over", "handed_over"]),
    discount: int.nonnegative(),
    amountPaid: int.nonnegative(),
    lines: z.array(z.object({
      productId: id,
      qty, unitPrice: int.nonnegative(), sellingQty: qty.optional(),
    })).min(1).max(100),
    /** The discount alert this correction came from, when started from an investigation. */
    alertId: id.nullable().optional(),
    /** Named debtor when a walk-in sale is corrected to carry an additional balance. */
    customerId: id.nullable().optional(),
  }),
});

/**
 * A selling-price change is its own operation: it never purchases stock, never moves the ledger and
 * never rewrites a completed sale. `expectedPrice` is the price the device displayed; when the
 * server already has a different current price the change is refused as a conflict instead of
 * silently overwriting a newer decision made on another device.
 */
export const PriceOp = z.object({
  type: z.literal("product.price.set"),
  payload: z.object({
    productId: id, priceId: id, newPrice: int.nonnegative(),
    reason: z.string().trim().min(3).max(500),
    effectiveAt: iso.optional(),
    expectedPrice: int.nonnegative().optional(),
    approvalRef: z.string().trim().max(120).optional(),
  }),
});

export const Operation = z.discriminatedUnion("type", [SaleOp, ReturnOp, PriceOp, PurchaseOp, ReceiptOp, ExpenseOp, ExpenseUpdateOp, CountOp, AdjustmentOp, ProductOp, SupplierOp, CustomerOp, CreditPaymentOp, AlertActionOp, CorrectionRequestOp]).and(
  z.object({ opId: id, deviceId: z.string().min(1).max(64), createdAt: iso }),
);
export type OperationT = z.infer<typeof Operation>;
export type ReturnPayload = z.infer<typeof ReturnOp>["payload"];
export type PricePayload = z.infer<typeof PriceOp>["payload"];

export const PushRequest = z.object({ operations: z.array(Operation).min(1).max(100) });
export type OpStatus = "applied" | "duplicate" | "conflict" | "rejected" | "pending_approval";
/** The server's answer to one pushed operation. `stock` is the authoritative on-hand figure for
 *  every product the operation touched (base units), returned with applied/duplicate verdicts so a
 *  device can correct its optimistic row immediately instead of waiting for the next pull — a pull
 *  that fails after the verdict used to leave a recorded receipt looking like empty stock. */
export interface OpResult { opId: string; status: OpStatus; message?: string; serverRef?: string; stock?: Record<string, number> }
export interface PullResponse {
  checkpoint: string;
  changes: { entity: string; id: string; data: unknown; deleted?: boolean }[];
  hasMore: boolean;
  /** Monotonic per-shop marker for dashboard-visible data; absent from older API builds. */
  revision?: string;
}
