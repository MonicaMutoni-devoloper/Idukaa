import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import Constants from "expo-constants";
import { Button, Card, Screen } from "../../src/components/ui";
import { useT } from "../../src/localization";
import { useSession } from "../../src/services/api";
import { checkForUpdates, useAppUpdate } from "../../src/services/updates";
import { secondaryNav } from "../../src/navigation";
import { radius, space, type, useTheme } from "../../src/theme/tokens";

export default function More() {
  const t = useT(); const c = useTheme(); const router = useRouter();  const user = useSession((s) => s.user)!;
  const items = secondaryNav(user.role);
  const verdict = useAppUpdate((s) => s.verdict);
  const checking = useAppUpdate((s) => s.checking);

  return (
    <Screen title={t("more.title")} subtitle={t("more.subtitle")}>
      <Card padded={false} style={{ overflow: "hidden" }}>
        {items.map((item, i) => (
          <Pressable key={item.href} testID={`more-${item.href.replace("/", "")}`} accessibilityRole="link" onPress={() => router.push(item.href as any)}
            style={({ hovered, pressed }: any) => ({ paddingVertical: space.lg, paddingHorizontal: space.lg, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.line, backgroundColor: pressed ? c.surfaceMuted : hovered ? c.surfaceMuted : "transparent", flexDirection: "row", alignItems: "center", gap: space.md, borderRadius: radius.sm })}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: c.ink, fontWeight: "700", fontSize: 15 }}>{t(item.key)}</Text>
              {item.description ? <Text style={{ color: c.muted, fontSize: 12 }}>{t(item.description)}</Text> : null}
            </View>
            <Text style={{ color: c.muted, fontSize: 16 }}>›</Text>
          </Pressable>
        ))}
      </Card>
      <Card style={{ gap: space.sm }}>
        <Text style={{ color: c.ink, fontWeight: "700", fontSize: 15 }}>{t("update.check")}</Text>
        <Text style={{ color: c.muted, fontSize: 12 }}>{t("update.current")}: {Constants.expoConfig?.version ?? "—"}</Text>
        {verdict.kind === "up-to-date" ? <Text style={{ color: c.success, fontSize: 12 }}>{t("update.upToDate")}</Text> : null}
        <View style={{ flexDirection: "row" }}>
          <Button testID="update-check" label={checking ? t("update.checking") : t("update.check")} disabled={checking}
            onPress={() => void checkForUpdates(true)} />
        </View>
      </Card>
      <Text style={{ color: c.muted, fontSize: 12 }}>{t("more.footer")}</Text>
    </Screen>
  );
}
