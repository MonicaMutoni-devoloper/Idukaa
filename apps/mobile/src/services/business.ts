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
export interface Alert {
  id: string; dedupeKey: string; category: string; severity: "info" | "warning" | "critical"; title: string;
  explanation: string; entityType: string | null; entityId: string | null; evidence: Record<string, unknown>;
  status: "open" | "investigating" | "resolved" | "legitimate"; notes: string;
  firstSeenAt: string; lastSeenAt: string; resolvedAt: string | null;
  events?: { id: number; action: string; note: string | null; at: string; actor: string | null }[];
}

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

export const getAlerts = (status?: string, severity?: string) => {
  const q = new URLSearchParams();
  if (status) q.set("status", status);
  if (severity) q.set("severity", severity);
  const query = q.toString();
  return request<Alert[]>(`/alerts${query ? `?${query}` : ""}`);
};
export const getAlert = (id: string) => request<Alert>(`/alerts/${id}`);
export const detectAlerts = () => request<{ ok: true; evaluatedAt: string; findings: number; created: number; updated: number; sufficientHistory: boolean }>("/alerts/detect", { method: "POST", body: {} });
export const changeAlertStatus = (id: string, status: "investigating" | "resolved" | "legitimate", note: string) =>
  request<Alert>(`/alerts/${id}/status`, { method: "POST", body: { status, note } });
