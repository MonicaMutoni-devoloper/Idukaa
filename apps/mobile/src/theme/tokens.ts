import { Platform, useColorScheme, type TextStyle } from "react-native";
import { create } from "zustand";
import { kvGet, kvSet } from "../database";

/**
 * Design tokens for the whole product. One source of truth for colour, spacing, type, motion and
 * elevation so screens cannot drift apart. Semantic names only (no raw hex in screens).
 *
 * Navy + Teal system:
 *   sidebar/nav `#172B4D` · interactive teal `#0D9488` · app background `#F6F8FA` ·
 *   cards `#FFFFFF` · main text `#172033` · secondary text `#667085` · borders `#E4E8EE`.
 * Filled buttons use `primaryStrong` (teal-700) instead of `primary`: white labels need 4.5:1 and
 * plain `#0D9488` only reaches 3.7:1. `primary` stays the accent for indicators, links, focus,
 * icons and active states, where 3:1 against adjacent colours is the requirement.
 */
const light = {
  bg: "#F6F8FA",
  bgAlt: "#EEF2F7",
  surface: "#FFFFFF",
  surfaceMuted: "#F3F6FA",
  ink: "#172033",
  inkSoft: "#33415C",
  muted: "#667085",
  line: "#E4E8EE",
  lineStrong: "#CFD6E0",
  primary: "#0D9488",
  primaryStrong: "#0F766E",
  primaryHover: "#0B5F58",
  primaryPressed: "#084C47",
  primarySoft: "#E3F5F3",
  onPrimary: "#FFFFFF",
  hover: "#F1F4F8",
  pressed: "#E7ECF3",
  disabledBg: "#E9EDF3",
  disabledInk: "#98A2B3",
  accent: "#B45309",
  accentSoft: "#FDF1E1",
  warnBg: "#FDF1E1",
  warning: "#D97706",
  danger: "#DC2626",
  dangerSoft: "#FEF1F1",
  dangerBg: "#FEF1F1",
  success: "#15803D",
  successSolid: "#16A34A",
  successSoft: "#E9F6EE",
  okBg: "#E9F6EE",
  focus: "#0D9488",
  infoSoft: "#E9EEF7",
  info: "#34507E",
  overlay: "rgba(23,32,51,0.46)",
  sidebar: "#172B4D",
  sidebarHover: "rgba(255,255,255,0.07)",
  sidebarActive: "rgba(255,255,255,0.11)",
  sidebarInk: "#E7ECF4",
  sidebarMuted: "#A9B6CC",
  sidebarIndicator: "#2DD4BF",
  sidebarLine: "rgba(255,255,255,0.09)",
} as const;

/** Dark scheme: the same navy/teal identity, not a different product. */
const dark: Palette = {
  bg: "#0D1520",
  bgAlt: "#111C2B",
  surface: "#152130",
  surfaceMuted: "#1B2A3C",
  ink: "#E9EDF4",
  inkSoft: "#C4CEDC",
  muted: "#8E9AAE",
  line: "#26344A",
  lineStrong: "#37475F",
  primary: "#2DD4BF",
  primaryStrong: "#14B8A6",
  primaryHover: "#0EA5A0",
  primaryPressed: "#0D8F8B",
  primarySoft: "#0F3A3A",
  onPrimary: "#04211F",
  hover: "#1B2A3C",
  pressed: "#223349",
  disabledBg: "#1E2B3D",
  disabledInk: "#6B7789",
  accent: "#FBBF24",
  accentSoft: "#3A2E12",
  warnBg: "#3A2E12",
  warning: "#F59E0B",
  danger: "#F87171",
  dangerSoft: "#3A1D1D",
  dangerBg: "#3A1D1D",
  success: "#4ADE80",
  successSolid: "#22C55E",
  successSoft: "#12301F",
  okBg: "#12301F",
  focus: "#2DD4BF",
  infoSoft: "#16253A",
  info: "#93B8E8",
  overlay: "rgba(6,12,22,0.62)",
  sidebar: "#101E36",
  sidebarHover: "rgba(255,255,255,0.06)",
  sidebarActive: "rgba(255,255,255,0.10)",
  sidebarInk: "#DCE4F0",
  sidebarMuted: "#93A2BC",
  sidebarIndicator: "#2DD4BF",
  sidebarLine: "rgba(255,255,255,0.08)",
};

export type Palette = { [K in keyof typeof light]: string };
export type ThemeMode = "light" | "dark" | "system";
export type Scheme = "light" | "dark";

const THEME_KEY = "theme_mode";
const isMode = (v: unknown): v is ThemeMode => v === "light" || v === "dark" || v === "system";

/**
 * Appearance preference. Stored as a plain preference in the app's own KV store (SQLite on Android,
 * IndexedDB on web). On web it is mirrored to one localStorage key so the first paint can match the
 * stored theme without waiting for IndexedDB; nothing but "light" | "dark" | "system" is kept there.
 */
const initialMode = (): ThemeMode => {
  if (Platform.OS === "web" && typeof localStorage !== "undefined") {
    try { const v = localStorage.getItem(THEME_KEY); if (isMode(v)) return v; } catch { /* storage disabled */ }
  }
  return "system";
};

export const useThemeMode = create<{ mode: ThemeMode; setMode: (mode: ThemeMode) => void }>((set) => ({
  mode: initialMode(),
  setMode: (mode) => { set({ mode }); persistThemeMode(mode); },
}));

export async function loadThemeMode() {
  try {
    const v = await kvGet(THEME_KEY);
    if (isMode(v)) useThemeMode.setState({ mode: v });
  } catch { /* keep the initial preference */ }
}

async function persistThemeMode(mode: ThemeMode) {
  if (Platform.OS === "web" && typeof localStorage !== "undefined") {
    try { localStorage.setItem(THEME_KEY, mode); } catch { /* storage disabled */ }
  }
  try { await kvSet(THEME_KEY, mode); } catch { /* the in-memory preference still applies */ }
}

/** Tells the browser which colour scheme and chrome colour to use (no incorrect flash on reload). */
export function applyWebChrome(scheme: Scheme) {
  if (Platform.OS !== "web" || typeof document === "undefined") return;
  const palette = scheme === "dark" ? dark : light;
  document.documentElement.style.colorScheme = scheme;
  document.documentElement.style.backgroundColor = palette.bg;
  document.body.style.backgroundColor = palette.bg;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", palette.primary);
}

export const useEffectiveScheme = (): Scheme => {
  const mode = useThemeMode((s) => s.mode);
  const system = useColorScheme();
  if (mode === "system") return system === "dark" ? "dark" : "light";
  return mode;
};

export const useTheme = (): Palette => (useEffectiveScheme() === "dark" ? dark : light);

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 } as const;
export const radius = { sm: 8, md: 12, lg: 16, pill: 999 } as const;

const weight = (w: TextStyle["fontWeight"]) => w;
export const type = {
  display: { fontSize: 30, lineHeight: 36, fontWeight: weight("800"), letterSpacing: -0.4 } as TextStyle,
  h1: { fontSize: 22, lineHeight: 28, fontWeight: weight("700"), letterSpacing: -0.2 } as TextStyle,
  h2: { fontSize: 17, lineHeight: 23, fontWeight: weight("700") } as TextStyle,
  h3: { fontSize: 15, lineHeight: 20, fontWeight: weight("700") } as TextStyle,
  body: { fontSize: 15, lineHeight: 21, fontWeight: weight("400") } as TextStyle,
  strong: { fontSize: 15, lineHeight: 21, fontWeight: weight("600") } as TextStyle,
  small: { fontSize: 13, lineHeight: 18, fontWeight: weight("400") } as TextStyle,
  caption: { fontSize: 11, lineHeight: 15, fontWeight: weight("700"), letterSpacing: 0.6 } as TextStyle,
  money: { fontSize: 20, lineHeight: 26, fontWeight: weight("800"), fontVariant: ["tabular-nums"] as TextStyle["fontVariant"] } as TextStyle,
  moneyLarge: { fontSize: 26, lineHeight: 32, fontWeight: weight("800"), letterSpacing: -0.3, fontVariant: ["tabular-nums"] as TextStyle["fontVariant"] } as TextStyle,
} as const;

/** Motion: quick, consistent and easy to disable. Screens read these instead of inventing durations. */
export const motion = {
  instant: 90,
  fast: 140,
  base: 190,
  slow: 260,
  page: 220,
  count: 480,
} as const;

export const elevation = {
  card: { shadowColor: "#172033", shadowOpacity: 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 1 },
  raised: { shadowColor: "#172033", shadowOpacity: 0.16, shadowRadius: 28, shadowOffset: { width: 0, height: 12 }, elevation: 8 },
} as const;

export const BREAKPOINT_WIDE = 900; // >= : sidebar layout (PC); below: bottom navigation (phone)
export const MAX_WIDTH = 1180;
