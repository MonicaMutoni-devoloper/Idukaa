import { create } from "zustand";
import { en, type Key } from "./en";
import { rw } from "./rw";
import { kvGet, kvSet } from "../database";
export type Lang = "en" | "rw";
const dict = { en, rw } as const;
export const useLang = create<{ lang: Lang; set: (l: Lang) => void }>((set) => ({ lang: "en", set: (lang) => { set({ lang }); void kvSet("lang", lang); } }));
export const loadLang = async () => { const l = await kvGet("lang"); if (l === "en" || l === "rw") useLang.setState({ lang: l }); };
/** Language is UI-only state; switching never touches records, drafts live in component state keyed by screen. */
export function useT() { const lang = useLang((s) => s.lang); return (k: Key) => dict[lang][k] ?? en[k]; }
export type { Key };
