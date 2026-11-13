import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { formatRwf } from "@sms/shared";
import { Badge, Banner, Button, Card, Empty, Field, Modal, Screen, Segmented, useToasts } from "../../src/components/ui";
import { useT } from "../../src/localization";
import { applyLocalCreditPayment, cacheCustomerBalances, enqueue, listCustomers, type LocalCustomer } from "../../src/database";
import { useSession } from "../../src/services/api";
import { syncNow } from "../../src/synchronization/engine";
import {
  createCustomer, getCreditSummary, getCustomerStatement, getCustomers, prepareReminder,
  type CreditSummary, type Customer, type Statement,
} from "../../src/services/business";
import { uuid } from "../../src/services/util";
import { space, type, useTheme } from "../../src/theme/tokens";

type Method = "cash" | "momo" | "bank";

export default function Customers() {
  const t = useT(); const c = useTheme(); const user = useSession((s) => s.user)!;
  const toast = useToasts((s) => s.push);
  const [rows, setRows] = useState<Customer[]>([]);
  const [summary, setSummary] = useState<CreditSummary | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState(""); const [phone, setPhone] = useState(""); const [address, setAddress] = useState(""); const [limit, setLimit] = useState("0");
  const [selected, setSelected] = useState<Customer | null>(null);
  const [statement, setStatement] = useState<Statement | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [amount, setAmount] = useState(""); const [method, setMethod] = useState<Method>("cash"); const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    // Cached accounts keep the screen useful offline; the server refresh adds authoritative balances.
    const cached = await listCustomers(search).catch(() => [] as LocalCustomer[]);
    setRows(cached.map((x) => ({ id: x.id, name: x.name, phone: x.phone, address: x.address, notes: x.notes,
      creditLimit: x.credit_limit, status: x.status, balance: x.balance ?? 0, overdue: x.overdue ?? 0 })));
    try {
      const [serverRows, serverSummary] = await Promise.all([getCustomers(search), getCreditSummary()]);
      setRows(serverRows); setSummary(serverSummary);
      // Keep the last confirmed balance on the device so a repayment can be queued offline.
      await cacheCustomerBalances(serverRows).catch(() => undefined);
    } catch (e: any) {
      if (e?.status === 403) setError(t("shops.pending"));
    }
  }, [search, t]);
  useEffect(() => { void load(); }, [load]);

  async function add() {
    if (name.trim().length < 2) return;
    setBusy(true); setError(null);
    try {
      await createCustomer({ id: uuid(), name: name.trim(), phone: phone.trim() || undefined, address: address.trim() || undefined, creditLimit: Math.max(0, Number(limit) || 0) });
      setAddOpen(false); setName(""); setPhone(""); setAddress(""); setLimit("0");
      toast(t("credit.saved")); await syncNow(true); await load();
    } catch (e: any) {
      setError(e?.body?.message === "customer_phone_in_use" ? t("common.error") : t("common.error"));
    } finally { setBusy(false); }
  }

  async function openStatement(customer: Customer) {
    setSelected(customer); setStatement(null);
    try { setStatement(await getCustomerStatement(customer.id)); }
    catch (e: any) { setError(e?.status === 403 ? t("shops.pending") : t("common.error")); }
  }

  async function pay() {
    if (!selected || !(Number(amount) > 0)) return;
    const at = new Date().toISOString(); const value = Math.round(Number(amount));
    // The server remains authoritative, but a stale cached balance must not let the form queue an
    // obviously oversized repayment. The queued operation is still checked again on push.
    if (typeof selected.balance === "number" && value > selected.balance) {
      setError(t("credit.paymentExceeds")); return;
    }
    setBusy(true); setError(null);
    try {
      const ref = reference.trim() || `PAY-${uuid().slice(0, 8).toUpperCase()}`;
      await enqueue(user.id, uuid(), "credit.payment.create", {
        paymentId: uuid(), customerId: selected.id, amount: value, paidAt: at, method, reference: ref,
      }, {}, () => applyLocalCreditPayment(selected.id, value), at);
      setSelected({ ...selected, balance: Math.max(0, (selected.balance ?? 0) - value) });
      setPayOpen(false); setAmount(""); setReference("");
      toast(t("credit.paymentSaved")); await syncNow();
      await openStatement(selected); await load();
    } catch { setError(t("common.error")); }
    finally { setBusy(false); }
  }

  async function remind() {
    if (!selected) return;
    try { await prepareReminder(selected.id); toast(t("credit.notSent")); }
    catch { setError(t("common.error")); }
  }

  return (
    <Screen title={t("credit.title")} subtitle={t("credit.subtitle")}
      actions={<Button testID="credit-add" label={t("credit.add")} onPress={() => setAddOpen(true)} />}>
      {error ? <Banner tone="danger" text={error} /> : null}
      {summary ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
          <Card style={{ flexGrow: 1, flexBasis: 180 }}><Money label={t("credit.outstanding")} value={summary.outstanding} tone={c.accent} /></Card>
          <Card style={{ flexGrow: 1, flexBasis: 160 }}><Money label={t("credit.collectedToday")} value={summary.collectedToday} /></Card>
          <Card style={{ flexGrow: 1, flexBasis: 160 }}><Money label={t("credit.collectedMonth")} value={summary.collectedThisMonth} /></Card>
          <Card style={{ flexGrow: 1, flexBasis: 160 }}><Money label={t("credit.overdue")} value={summary.overdue} tone={c.danger} /></Card>
          <Card style={{ flexGrow: 1, flexBasis: 140 }}><Money label={t("credit.nearLimit")} value={summary.nearLimit} plain /></Card>
        </View>
      ) : null}
      <Field label={t("common.search")} placeholder={`${t("credit.name")} / ${t("credit.phone")}`} value={search} onChangeText={setSearch} />
      <View style={{ gap: space.sm }}>
        {rows.map((customer) => (
          <Card key={customer.id} style={{ gap: space.sm }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
              <Text style={{ flex: 1, minWidth: 120, color: c.ink, fontWeight: "700", fontSize: 15 }}>{customer.name}</Text>
              {customer.phone ? <Text style={{ color: c.muted, fontSize: 12 }}>{customer.phone}</Text> : null}
              <Badge tone={customer.status === "blocked" ? "danger" : customer.balance && customer.balance > 0 ? "warn" : "ok"}
                label={customer.status === "blocked" ? t("common.error") : customer.balance ? formatRwf(customer.balance) : "0 RWF"} />
            </View>
            <View style={{ flexDirection: "row", gap: space.lg, flexWrap: "wrap" }}>
              <Text style={{ color: c.muted, fontSize: 12 }}>{t("credit.limit")}: <Text style={{ color: c.ink, fontWeight: "600" }}>{formatRwf(customer.creditLimit)}</Text></Text>
              {customer.overdue ? <Text style={{ color: c.danger, fontSize: 12 }}>{t("credit.overdue")}: {formatRwf(customer.overdue)}</Text> : null}
            </View>
            <View style={{ flexDirection: "row", gap: space.sm }}>
              <Button size="sm" kind="secondary" label={t("credit.statement")} onPress={() => void openStatement(customer)} />
              <Button size="sm" label={t("credit.payment")} disabled={!customer.balance} onPress={() => { setSelected(customer); setPayOpen(true); }} />
            </View>
          </Card>
        ))}
        {!rows.length ? <Empty title={t("credit.noCustomers")} description={t("credit.paymentHint")} /> : null}
      </View>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title={t("credit.add")} footer={
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
          <Button kind="secondary" label={t("common.cancel")} onPress={() => setAddOpen(false)} />
          <Button label={t("common.save")} loading={busy} disabled={name.trim().length < 2} onPress={() => void add()} />
        </View>
      }>
        <View style={{ gap: space.md }}>
          <Field label={t("credit.name")} value={name} onChangeText={setName} />
          <Field label={t("credit.phone")} value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
          <Field label={t("credit.address")} value={address} onChangeText={setAddress} />
          <Field label={t("credit.limit")} value={limit} onChangeText={setLimit} keyboardType="number-pad"
            hint={user.role === "owner" ? undefined : t("offline.center.forbidden")} />
        </View>
      </Modal>

      <Modal open={!!selected && !payOpen} onClose={() => { setSelected(null); setStatement(null); }} title={selected?.name ?? ""}
        footer={<View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
          <Button kind="secondary" label={t("credit.reminder")} onPress={() => void remind()} />
          <Button label={t("credit.payment")} disabled={!selected?.balance} onPress={() => setPayOpen(true)} />
        </View>} scroll>
        {statement ? (
          <View style={{ gap: space.md }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
              <Money label={t("credit.balance")} value={statement.customer.balance ?? 0} />
              <Money label={t("credit.limit")} value={statement.customer.creditLimit} />
            </View>
            <Text style={{ color: c.ink, fontWeight: "700" }}>{t("credit.statement")}</Text>
            {statement.sales.map((sale) => (
              <Row key={sale.id} left={`${new Date(sale.at).toLocaleDateString()} · ${sale.by}`} right={`${formatRwf(sale.credit)}`}
                sub={sale.status === "pending_approval" ? t("alerts.investigating") : `${t("common.total")} ${formatRwf(sale.total)} · ${t("common.paid")} ${formatRwf(sale.amountPaid)}`} />
            ))}
            {statement.payments.map((p) => (
              <Row key={p.id} left={`${new Date(p.at).toLocaleDateString()} · ${p.reference}`} right={`− ${formatRwf(p.amount)}`} sub={p.method} />
            ))}
            {statement.adjustments.map((a) => (
              <Row key={a.id} left={`${new Date(a.at).toLocaleDateString()} · ${a.reason}`} right={formatRwf(a.amount)} sub={t("credit.statement")} />
            ))}
            {!statement.sales.length && !statement.payments.length ? <Empty title={t("credit.statement")} /> : null}
          </View>
        ) : <Text style={{ color: c.muted }}>{t("common.loading")}</Text>}
      </Modal>

      <Modal open={payOpen} onClose={() => { setPayOpen(false); setAmount(""); }} title={t("credit.payment")} footer={
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
          <Button kind="secondary" label={t("common.cancel")} onPress={() => { setPayOpen(false); setAmount(""); }} />
          <Button label={t("common.save")} loading={busy} disabled={!(Number(amount) > 0)} onPress={() => void pay()} />
        </View>
      }>
        <View style={{ gap: space.md }}>
          <Text style={{ color: c.ink, fontWeight: "700" }}>{selected?.name}</Text>
          <Text style={{ color: c.muted, fontSize: 12 }}>{t("credit.balance")}: {formatRwf(selected?.balance ?? 0)}</Text>
          <Field label={t("credit.amount")} value={amount} onChangeText={setAmount} keyboardType="number-pad" />
          <Segmented<Method> label={t("credit.method")} value={method} onChange={setMethod} options={[
            { value: "cash", label: t("sell.cash") }, { value: "momo", label: t("sell.momo") }, { value: "bank", label: t("sell.bank") },
          ]} />
          <Field label={t("credit.reference")} value={reference} onChangeText={setReference} placeholder="PAY-…" />
          <Text style={{ color: c.muted, fontSize: 11 }}>{t("credit.paymentHint")}</Text>
        </View>
      </Modal>
    </Screen>
  );
}

function Money({ label, value, tone, plain }: { label: string; value: number; tone?: string; plain?: boolean }) {
  const c = useTheme();
  return <View style={{ gap: 2 }}><Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{label}</Text>
    <Text style={{ color: tone ?? c.ink, fontSize: 20, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{plain ? value.toLocaleString() : formatRwf(value)}</Text></View>;
}
function Row({ left, right, sub }: { left: string; right: string; sub?: string }) {
  const c = useTheme();
  return <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.md, paddingVertical: 6, borderTopWidth: 1, borderTopColor: c.line }}>
    <View style={{ flex: 1 }}><Text style={{ color: c.ink, fontSize: 13 }}>{left}</Text>{sub ? <Text style={{ color: c.muted, fontSize: 11 }}>{sub}</Text> : null}</View>
    <Text style={{ color: c.ink, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{right}</Text>
  </View>;
}
