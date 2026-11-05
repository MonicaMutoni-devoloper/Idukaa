import { useState } from "react";
import { Switch, Text, View } from "react-native";
import { Banner, Button, Card, Field, Screen, Segmented } from "../../src/components/ui";
import { enqueue } from "../../src/database/local";
import { useT } from "../../src/localization";
import { useSession } from "../../src/services/api";
import { refreshCounts, syncNow } from "../../src/synchronization/engine";
import { parseRwf, uuid } from "../../src/services/util";
import { space, type, useTheme } from "../../src/theme/tokens";

const today = () => new Date().toISOString().slice(0, 10);
const parseDay = (s: string): string | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d.toISOString() : null;
};

export default function Expense() {
  const t = useT(); const c = useTheme(); const user = useSession((s) => s.user)!;
  const [cat, setCat] = useState("rent"); const [amount, setAmount] = useState(""); const [paid, setPaid] = useState(true);
  const [note, setNote] = useState(""); const [day, setDay] = useState(today()); const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);

  async function save() {
    const a = parseRwf(amount); const incurredAt = parseDay(day);
    if (!a || a <= 0) { setErr(t("v.positive")); return; }
    if (!incurredAt) { setErr(t("expense.dateError")); return; }
    setErr(null); setBusy(true);
    try {
      await enqueue(user.id, uuid(), "expense.create", { expenseId: uuid(), category: cat, amount: a, paid, incurredAt, note: note.trim() || undefined }, {}, undefined, incurredAt);
      setAmount(""); setNote(""); setSaved(true); setDay(today());
      await refreshCounts(); void syncNow();
    } catch { setErr(t("common.error")); } finally { setBusy(false); }
  }

  return (
    <Screen title={t("expense.title")} subtitle={t("expense.subtitle")}>
      {saved ? <Banner tone="ok" title={t("expense.saved")} text={t("sync.savedLocally")} /> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg, alignItems: "flex-start" }}>
        <Card style={{ flexGrow: 1, flexBasis: 420, gap: space.md }}>
          <View style={{ gap: 6 }}>
            <Text style={{ color: c.inkSoft, fontSize: 12, fontWeight: "600" }}>{t("expense.category")}</Text>
            <Segmented value={cat} onChange={setCat} options={[
              { value: "rent", label: t("expense.rent") }, { value: "electricity", label: t("expense.electricity") },
              { value: "transport", label: t("expense.transport") }, { value: "other", label: t("expense.other") },
            ]} />
          </View>
          <View style={{ flexDirection: "row", gap: space.md, flexWrap: "wrap" }}>
            <Field testID="expense-amount" label={`${t("common.amount")} (RWF)`} value={amount} keyboardType="number-pad" onChangeText={(x) => { setSaved(false); setAmount(x); }} error={err} />
            <Field testID="expense-date" label={t("expense.date")} value={day} onChangeText={setDay} placeholder="YYYY-MM-DD" hint={t("expense.dateHelp")} />
          </View>
          <Field testID="expense-note" label={t("common.note")} value={note} onChangeText={setNote} placeholder={t("common.optional")} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
            <Switch testID="expense-paid" value={paid} onValueChange={setPaid} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: c.ink, fontWeight: "600", fontSize: 13 }}>{t("expense.paid")}</Text>
              <Text style={{ color: c.muted, fontSize: 11 }}>{t("expense.paidHelp")}</Text>
            </View>
          </View>
          <Button testID="expense-save" label={t("common.save")} loading={busy} onPress={() => void save()} />
        </Card>
        <Card tone="muted" style={{ flexGrow: 1, flexBasis: 260, gap: 6 }}>
          <Text style={{ color: c.ink, ...type.h2 }}>{t("expense.immutableTitle")}</Text>
          <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>{t("expense.immutable")}</Text>
        </Card>
      </View>
    </Screen>
  );
}
