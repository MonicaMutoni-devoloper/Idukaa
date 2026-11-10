import { useState } from "react";
import { Platform, Text, View } from "react-native";
import { Badge, Button, Card, KeyValue, Modal } from "./ui";
import { useT } from "../localization";
import { usePwaInstall } from "../services/pwa-install";
import { space, useTheme } from "../theme/tokens";

/**
 * Installation entry for the web/PWA build. It is deliberately placed in Settings rather than
 * shown as a repeated interstitial: a cashier must never be interrupted mid-sale by a prompt.
 * When Chrome offers its native install event the button triggers it; otherwise the same card
 * explains the real browser menu path, so there is never a button that silently does nothing.
 */
export function PwaInstallCard() {
  const t = useT(); const c = useTheme();
  const { available, installed, busy, lastOutcome, promptInstall } = usePwaInstall();
  const [help, setHelp] = useState(false);

  if (Platform.OS !== "web") return null;

  return (
    <>
      <View testID="pwa-install-card"><Card style={{ gap: space.md }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: c.ink, fontWeight: "700", fontSize: 14 }}>
              {t(installed ? "pwa.installedTitle" : "pwa.title")}
            </Text>
            <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>
              {t(installed ? "pwa.installedText" : "pwa.benefit")}
            </Text>
          </View>
          {installed ? <View testID="pwa-installed"><Badge tone="ok" dot label={t("pwa.installedBadge")} /></View> : null}
        </View>

        {!installed ? (
          <>
            {lastOutcome === "dismissed" || lastOutcome === "error" ? (
              <Text style={{ color: c.muted, fontSize: 12 }}>{t("pwa.cancelled")}</Text>
            ) : null}
            <Text style={{ color: c.muted, fontSize: 11, lineHeight: 16 }}>{t("pwa.firstDownload")}</Text>
            <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
              {available ? (
                <Button testID="pwa-install" label={busy ? t("pwa.installing") : t("pwa.install")} loading={busy}
                  onPress={() => void promptInstall()} />
              ) : null}
              <Button testID="pwa-install-help" kind={available ? "secondary" : "primary"} label={t("pwa.help")}
                onPress={() => setHelp(true)} />
            </View>
            {!available ? <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>{t("pwa.unavailable")}</Text> : null}
          </>
        ) : null}
      </Card></View>

      <Modal open={help} onClose={() => setHelp(false)} title={t("pwa.helpTitle")}
        description={t("pwa.helpIntro")} width={520} scroll
        footer={<Button kind="secondary" label={t("common.close")} onPress={() => setHelp(false)} />}>
        <View testID="pwa-install-steps" style={{ gap: 2 }}>
          <KeyValue label="1" value={t("pwa.androidStep")} />
          <KeyValue label="2" value={t("pwa.desktopStep")} />
          <KeyValue label="3" value={t("pwa.iosStep")} />
        </View>
        <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>{t("pwa.firstDownload")}</Text>
      </Modal>
    </>
  );
}
