import { Injectable, Logger } from "@nestjs/common";
import { Db } from "../db/db.service";

export interface NotificationPreferences {
  lowStock: boolean;
  outOfStock: boolean;
  salesActivity: boolean;
  inventoryUpdates: boolean;
  /** Always true: security notifications cannot be switched off by a preference. */
  security: true;
}

export type NotificationCategory = "security" | "low_stock" | "out_of_stock" | "sales_activity" | "inventory_updates";

export interface NotificationRow {
  id: string;
  category: NotificationCategory;
  kind: string;
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

const DEFAULTS: NotificationPreferences = { lowStock: true, outOfStock: true, salesActivity: true, inventoryUpdates: true, security: true };

/**
 * In-app notifications only. Nothing here claims SMS, e-mail or push delivery: there is no provider
 * configured, so notifications are persisted and read inside the app. Optional categories honour the
 * user's stored preferences at generation time; security categories are always generated.
 */
@Injectable()
export class NotificationService {
  private log = new Logger("Notifications");

  constructor(private db: Db) {}

  async preferences(userId: string): Promise<NotificationPreferences> {
    const [row] = await this.db.query(
      "SELECT low_stock, out_of_stock, sales_activity, inventory_updates FROM notification_preferences WHERE user_id=$1",
      [userId],
    );
    if (!row) return { ...DEFAULTS };
    return {
      lowStock: row.low_stock,
      outOfStock: row.out_of_stock,
      salesActivity: row.sales_activity,
      inventoryUpdates: row.inventory_updates,
      security: true,
    };
  }

  async savePreferences(userId: string, patch: Partial<Omit<NotificationPreferences, "security">>): Promise<NotificationPreferences> {
    const current = await this.preferences(userId);
    const next = { ...current, ...patch, security: true as const };
    await this.db.query(
      `INSERT INTO notification_preferences(user_id, low_stock, out_of_stock, sales_activity, inventory_updates)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id) DO UPDATE SET low_stock=EXCLUDED.low_stock, out_of_stock=EXCLUDED.out_of_stock,
         sales_activity=EXCLUDED.sales_activity, inventory_updates=EXCLUDED.inventory_updates, updated_at=now()`,
      [userId, next.lowStock, next.outOfStock, next.salesActivity, next.inventoryUpdates],
    );
    return next;
  }

  /** Insert a security notification. Never gated by a preference. */
  async security(userId: string, shopId: string | null, kind: string, data: Record<string, unknown> = {}) {
    try {
      await this.db.query(
        "INSERT INTO notifications(user_id, shop_id, category, kind, data) VALUES ($1,$2,'security',$3,$4)",
        [userId, shopId, kind, JSON.stringify(data)],
      );
    } catch (e) {
      // A notification must never break a login, password reset or 2FA change.
      this.log.warn(`could not store security notification ${kind}`);
    }
  }

  /**
   * Generates the optional notifications this user is allowed to receive, then returns their inbox.
   * Generation is idempotent: the same product/sale/purchase is not announced twice in 12 hours.
   */
  async inbox(userId: string, shopId: string | null): Promise<{ items: NotificationRow[]; unread: number; preferences: NotificationPreferences }> {
    const prefs = await this.preferences(userId);
    if (shopId) await this.generate(userId, shopId, prefs);
    const rows = await this.db.query(
      `SELECT id, category, kind, data, read_at, created_at FROM notifications
       WHERE user_id=$1 ORDER BY created_at DESC, id DESC LIMIT 50`,
      [userId],
    );
    const [{ count }] = await this.db.query(
      "SELECT count(*)::int AS count FROM notifications WHERE user_id=$1 AND read_at IS NULL",
      [userId],
    );
    return {
      items: rows.map((r: any) => ({
        id: r.id,
        category: r.category,
        kind: r.kind,
        data: r.data ?? {},
        readAt: r.read_at ? new Date(r.read_at).toISOString() : null,
        createdAt: new Date(r.created_at).toISOString(),
      })),
      unread: Number(count ?? 0),
      preferences: prefs,
    };
  }

  async markRead(userId: string, ids?: string[]) {
    if (ids?.length) {
      await this.db.query(
        "UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL AND id = ANY($2::uuid[])",
        [userId, ids],
      );
    } else {
      await this.db.query("UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL", [userId]);
    }
    return { ok: true };
  }

  private async generate(userId: string, shopId: string, prefs: NotificationPreferences) {
    if (prefs.outOfStock || prefs.lowStock) {
      const products = await this.db.query(
        `SELECT p.id, p.name, p.unit, p.low_stock_threshold, COALESCE(s.qty,0)::bigint AS qty
         FROM products p LEFT JOIN stock_on_hand s ON s.product_id=p.id AND s.shop_id=p.shop_id
         WHERE p.shop_id=$1 AND p.active=true`,
        [shopId],
      );
      for (const p of products) {
        const qty = Number(p.qty);
        if (qty <= 0 && prefs.outOfStock) {
          await this.insertOnce(userId, shopId, "out_of_stock", "product_out_of_stock", { productId: p.id, productName: p.name, unit: p.unit }, "productId");
        } else if (qty > 0 && qty <= Number(p.low_stock_threshold) && prefs.lowStock) {
          await this.insertOnce(userId, shopId, "low_stock", "product_low_stock", {
            productId: p.id, productName: p.name, unit: p.unit, qty, threshold: Number(p.low_stock_threshold),
          }, "productId");
        }
      }
    }

    if (prefs.salesActivity) {
      const sales = await this.db.query(
        `SELECT s.id, s.gross_amount, s.discount, s.payment_method, s.sold_at, u.full_name AS cashier
         FROM sales s JOIN users u ON u.id=s.user_id
         WHERE s.shop_id=$1 AND s.status='posted' AND s.user_id<>$2 AND s.sold_at > now() - interval '24 hours'
         ORDER BY s.sold_at DESC LIMIT 20`,
        [shopId, userId],
      );
      for (const s of sales) {
        await this.insertOnce(userId, shopId, "sales_activity", "sale_recorded", {
          saleId: s.id, cashier: s.cashier, net: Number(s.gross_amount) - Number(s.discount),
          paymentMethod: s.payment_method, soldAt: new Date(s.sold_at).toISOString(),
        }, "saleId");
      }
    }

    if (prefs.inventoryUpdates) {
      const purchases = await this.db.query(
        `SELECT p.id, p.total_amount, p.ordered_at, u.full_name AS recorded_by
         FROM purchases p JOIN users u ON u.id=p.user_id
         WHERE p.shop_id=$1 AND p.user_id<>$2 AND p.ordered_at > now() - interval '24 hours'
         ORDER BY p.ordered_at DESC LIMIT 20`,
        [shopId, userId],
      );
      for (const p of purchases) {
        await this.insertOnce(userId, shopId, "inventory_updates", "purchase_recorded", {
          purchaseId: p.id, total: Number(p.total_amount), recordedBy: p.recorded_by, orderedAt: new Date(p.ordered_at).toISOString(),
        }, "purchaseId");
      }
    }
  }

  /** One row per (user, kind, entity) per 12 hours, so opening the inbox does not spam. */
  private async insertOnce(
    userId: string, shopId: string, category: NotificationCategory, kind: string,
    data: Record<string, unknown>, entityKey: string, windowHours = 12,
  ) {
    try {
      await this.db.query(
        `INSERT INTO notifications(user_id, shop_id, category, kind, data)
         SELECT $1,$2,$3,$4,$5::jsonb
         WHERE NOT EXISTS (
           SELECT 1 FROM notifications
           WHERE user_id=$1 AND kind=$4 AND (data->>$6) = ($5::jsonb->>$6)
             AND created_at > now() - ($7::text || ' hours')::interval
         )`,
        [userId, shopId, category, kind, JSON.stringify(data), entityKey, String(windowHours)],
      );
    } catch (e) {
      this.log.warn(`notification generation skipped for ${kind}`);
    }
  }
}
