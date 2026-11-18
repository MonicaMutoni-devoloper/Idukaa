import { request } from "./api";

export interface ShopMembership {
  id: string; name: string; currency: string; location: string | null; category: string | null;
  active: boolean; role: "owner" | "manager"; shopStatus: string; employeeCount: number; openAlerts: number;
  subscriptionRequired: boolean; subscriptionStatus: string; planName: string | null; priceRwf: number | null; endsAt: string | null;
}
export interface CommandShop extends ShopMembership {
  sales: number | null; expenses: number | null; profit: number | null; outstandingCredit: number | null;
  stockAlerts: number | null; unavailableReason?: string;
}
export interface CommandCentre {
  from: string; to: string; shops: CommandShop[];
  totals: { sales: number; expenses: number; profit: number; outstandingCredit: number; stockAlerts: number; openAlerts: number };
  shopsRequiringPayment: number;
}
export interface Plan { id: string; code: string; name: string; priceRwf: number; durationDays: number }
export interface Subscription {
  id: string; shopId: string; planCode: string; planName: string; priceRwf: number; durationDays: number;
  status: string; startsAt: string | null; endsAt: string | null; paymentReference: string | null; createdAt: string;
}
export interface Customer {
  id: string; name: string; phone: string | null; address: string | null; notes: string | null;
  creditLimit: number; status: "active" | "blocked"; createdAt?: string; balance?: number; overdue?: number; lastPaymentAt?: string | null;
}
export interface CreditSummary {
  outstanding: number; overdue: number; customersWithBalance: number; nearLimit: number;
  collectedToday: number; collectedThisMonth: number;
}
export interface Statement {
  customer: Customer;
  sales: { id: string; at: string; total: number; amountPaid: number; credit: number; dueAt: string | null; status: string; by: string }[];
  payments: { id: string; at: string; amount: number; method: string; reference: string }[];
  adjustments: { id: string; at: string; amount: number; reason: string }[];
}
export type AlertStatusGroup = "open" | "investigating" | "action_required" | "escalated" | "resolved";
export type AlertSeverityLevel = "critical" | "high" | "medium" | "low";
export type AlertResolutionCategory = "approved_activity" | "human_error" | "suspicious_activity" | "false_positive" | "other";

export interface Alert {
  id: string; dedupeKey: string; category: string; severity: "info" | "warning" | "critical";
  severityLevel: AlertSeverityLevel; title: string; explanation: string;
  entityType: string | null; entityId: string | null; evidence: Record<string, unknown>;
  status: string; statusGroup: AlertStatusGroup; notes: string;
  assignedTo: string | null; assignedToName: string | null; assignedAt: string | null;
  resolutionCategory: AlertResolutionCategory | null; resolutionNote: string | null; correctiveAction: string | null;
  escalatedTo: string | null; escalatedToName: string | null; escalatedAt: string | null; approvedByName: string | null;
  firstSeenAt: string; lastSeenAt: string; resolvedAt: string | null; resolvedByName: string | null;
}
export interface AlertSummary {
  total: number; open: number; investigating: number; actionRequired: number; escalated: number;
  resolved: number; criticalOpen: number;
}
export interface AlertEvent {
  id: number; action: string; note: string | null; at: string; actor: string | null;
  previous_status: string | null; new_status: string | null; details: Record<string, unknown> | null;
}
export interface AlertDetail extends Alert {
  resolution: { category: AlertResolutionCategory | null; note: string | null; correctiveAction: string | null;
    approvedByName: string | null; escalatedToName: string | null; escalatedAt: string | null };
  supporting: { kind: string; fields: { label: string; value: string | number | null }[];
    related: { label: string; id: string; at?: string | null }[] };
  events: AlertEvent[];
  actions: Record<"investigate" | "assign" | "note" | "escalate" | "resolve" | "reopen", boolean>;
}
export interface AlertFilters {
  status?: string; severity?: string; category?: string; employee?: string;
  from?: string; to?: string; search?: string;
}
export interface AlertStaff { id: string; name: string; role: "owner" | "manager" }

export const getMemberships = () => request<ShopMembership[]>("/shop/memberships");
export const switchShop = (shopId: string) => request<{ ok: true; shopId: string; shopName: string; role: "owner" | "manager" }>("/shop/switch", { method: "POST", body: { shopId } });
export const getCommandCentre = (from: string, to: string) =>
  request<CommandCentre>(`/shop/command-centre?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
export const getPlans = () => request<Plan[]>("/subscriptions/plans");
export const getSubscription = () => request<{ required: boolean; current: Subscription | null; history: Subscription[] }>("/subscriptions");
export interface PendingSubscription extends Subscription { shopName: string }
export const getPendingSubscriptions = () => request<PendingSubscription[]>("/subscriptions/admin/pending");
export const verifySubscription = (id: string, paymentReference?: string) =>
  request<{ ok: true; alreadyActive: boolean; subscription: Subscription }>(`/subscriptions/${id}/verify`, { method: "POST", body: { paymentReference } });
export const checkoutSubscription = (planCode: string, shopId?: string) =>
  request<{ ok: true; alreadyActive: boolean; subscription: Subscription }>("/subscriptions/checkout", { method: "POST", body: { planCode, shopId } });

export const getCustomers = (search = "") => request<Customer[]>(`/customers?search=${encodeURIComponent(search)}`);
export const getCreditSummary = () => request<CreditSummary>("/customers/summary");
export const getCustomerStatement = (id: string) => request<Statement>(`/customers/${id}/statement`);
export const createCustomer = (body: { id?: string; name: string; phone?: string; address?: string; notes?: string; creditLimit?: number }) =>
  request<Customer>("/customers", { method: "POST", body });
export const updateCustomer = (id: string, body: Partial<Customer> & { creditLimit?: number }) =>
  request<Customer>(`/customers/${id}`, { method: "PATCH", body });
export const prepareReminder = (id: string, message?: string) =>
  request<{ id: string; status: string; deliveryStatus: string; message: string }>(`/customers/${id}/reminders`, { method: "POST", body: { message } });

export interface PendingCreditSale {
  id: string; at: string; gross: number; discount: number; amountPaid: number; credit: number;
  customerId: string; customer: string; by: string; dueAt: string | null;
  lines: { productId: string; name: string; qty: number; lineAmount: number }[];
}
export const getPendingCreditSales = () => request<PendingCreditSale[]>("/sales/pending-credit");
export const decideCreditSale = (id: string, approve: boolean, reason: string) =>
  request<{ ok: true; saleId: string; status: string }>(`/sales/${id}/${approve ? "approve-credit" : "reject-credit"}`, { method: "POST", body: { reason } });

export const getAlerts = (f: AlertFilters = {}) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) q.set(k, v);
  const query = q.toString();
  return request<{ alerts: Alert[]; summary: AlertSummary }>(`/alerts${query ? `?${query}` : ""}`);
};
export const getAlert = (id: string) => request<AlertDetail>(`/alerts/${id}`);
export const getAlertStaff = () => request<AlertStaff[]>("/alerts/staff");
export const detectAlerts = () => request<{ ok: true; evaluatedAt: string; findings: number; created: number; updated: number; sufficientHistory: boolean }>("/alerts/detect", { method: "POST", body: {} });
export type AlertAction = "investigate" | "assign" | "note" | "escalate" | "resolve" | "reopen";
export const actOnAlert = (id: string, body: {
  action: AlertAction; note: string; assignedTo?: string | null; category?: AlertResolutionCategory | null;
  correctiveAction?: string | null; escalateTo?: string | null; approvedBy?: string | null;
}) => request<Alert>(`/alerts/${id}/actions`, { method: "POST", body });
export const getAlertSettings = () => request<{ thresholds: Record<string, number>; defaults: Record<string, number> }>("/alerts/settings");
export const saveAlertSettings = (thresholds: Record<string, number>) =>
  request<{ thresholds: Record<string, number> }>("/alerts/settings", { method: "PUT", body: thresholds });
