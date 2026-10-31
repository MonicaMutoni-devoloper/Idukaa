import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Badge, Button, Card, ErrorState, Loading, Screen } from "../../../src/components/ui";
import { useT } from "../../../src/localization";
import { request } from "../../../src/services/api";
import { space, type, useTheme } from "../../../src/theme/tokens";

interface Health { status: string; db_time: string; open_conflicts: number }

export default function AdminHealth() {
  const t = useT(); const c = useTheme();
  const [h, setH] = useState<Health | null>(null); const [failed, setFailed] = useState(false); const [at, setAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try { setH(await request<Health>("/admin/health")); setAt(Date.now()); } catch { setFailed(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <Screen title={t("admin.health")} subtitle={t("admin.healthDesc")} actions={<Button kind="secondary" label={t("admin.refresh")} onPress={() => void load()} />}>
      {failed ? <ErrorState onRetry={() => void load()} /> : !h ? <Loading /> : (
        <>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
            <Card style={{ flexGrow: 1, flexBasis: 200, gap: 4 }}>
              <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("admin.systemStatus")}</Text>
              <Badge dot tone={h.status === "ok" ? "ok" : "danger"} label={h.status === "ok" ? t("admin.ok") : h.status} />
              {at ? <Text style={{ color: c.muted, fontSize: 12 }}>{t("admin.checkedAt")}: {new Date(at).toLocaleTimeString()}</Text> : null}
            </Card>
            <Card style={{ flexGrow: 1, flexBasis: 200, gap: 4 }}>
              <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("admin.dbTime")}</Text>
              <Text style={{ color: c.ink, fontSize: 15, fontWeight: "700" }}>{new Date(h.db_time).toLocaleString()}</Text>
              <Text style={{ color: c.muted, fontSize: 12 }}>{t("admin.dbTimeHelp")}</Text>
            </Card>
            <Card style={{ flexGrow: 1, flexBasis: 200, gap: 4 }}>
              <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("admin.openConflicts")}</Text>
              <Text style={{ color: h.open_conflicts ? c.accent : c.ink, ...type.money }}>{h.open_conflicts}</Text>
              <Text style={{ color: c.muted, fontSize: 12 }}>{t("admin.openConflictsHelp")}</Text>
            </Card>
          </View>
          <Card tone="muted" style={{ gap: 6 }}>
            <Text style={{ color: c.ink, fontWeight: "700", fontSize: 13 }}>{t("admin.healthHelpTitle")}</Text>
            <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>{t("admin.healthHelp")}</Text>
          </Card>
        </>
      )}
    </Screen>
  );
}
