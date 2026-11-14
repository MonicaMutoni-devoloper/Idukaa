import { useCallback } from "react";
import { create } from "zustand";
import { en, type Key } from "./en";
import { rw } from "./rw";
import { kvGet, kvSet } from "../database";
export type Lang = "en" | "rw";
const dict = { en, rw } as const;
export const useLang = create<{ lang: Lang; set: (l: Lang) => void }>((set) => ({ lang: "en", set: (lang) => { set({ lang }); void kvSet("lang", lang); } }));
export const loadLang = async () => { const l = await kvGet("lang"); if (l === "en" || l === "rw") useLang.setState({ lang: l }); };
/** Language is UI-only state; switching never touches records, drafts live in component state keyed by screen. */
export function useT() {
  const lang = useLang((s) => s.lang);
  // Stable per language: screens put `t` in load callbacks, and a fresh function every render would
  // re-run their effects endlessly.
  return useCallback((k: Key) => dict[lang][k] ?? en[k], [lang]);
}
export type { Key };
