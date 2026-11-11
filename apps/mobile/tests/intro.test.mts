/**
 * The introduction is a one-time product surface, so its timing, illustration and storage contract
 * are checked here instead of being left as loose numbers inside a component.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  INTRO_FIRST_MS, INTRO_REDUCED_FIRST_MS, INTRO_REDUCED_RETURNING_MS, INTRO_RETURNING_MS,
  INTRO_SEEN_KEY, INTRO_STAGE_MS, introDurationFor, isIntroPreviewUrl,
} from "../src/services/intro.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

test("first launch gets a 7–8 second introduction and later launches a 0.8–1 second transition", () => {
  assert.ok(introDurationFor("first", false) >= 7000 && introDurationFor("first", false) <= 8000);
  assert.ok(introDurationFor("returning", false) >= 800 && introDurationFor("returning", false) <= 1000);
  assert.equal(introDurationFor("first", false), INTRO_FIRST_MS);
  assert.equal(introDurationFor("returning", false), INTRO_RETURNING_MS);
  assert.equal(introDurationFor("loading", false), 0);
  assert.equal(introDurationFor("done", false), 0);
});

test("all three shop scenes hold their caption for at least 1.8 seconds", () => {
  assert.deepEqual([...INTRO_STAGE_MS], [0, 2500, 5000, 7500, 8000]);
  for (let i = 0; i < 3; i += 1) {
    assert.ok(INTRO_STAGE_MS[i + 1] - INTRO_STAGE_MS[i] >= 1800, `scene ${i + 1} is too short`);
  }
  assert.ok(INTRO_STAGE_MS[4] - INTRO_STAGE_MS[3] >= 400, "the brand hand-off must be visible");
});

test("reduced motion keeps the full reading time but never adds a second wait", () => {
  assert.equal(introDurationFor("first", true), INTRO_REDUCED_FIRST_MS);
  assert.equal(introDurationFor("returning", true), INTRO_REDUCED_RETURNING_MS);
  assert.ok(INTRO_REDUCED_FIRST_MS >= 7000 && INTRO_REDUCED_FIRST_MS <= 8000);
  assert.ok(INTRO_REDUCED_RETURNING_MS >= 800 && INTRO_REDUCED_RETURNING_MS <= 1000);
});

test("the completion flag is installation-wide and versioned", () => {
  assert.equal(INTRO_SEEN_KEY, "intro_seen_v1");
  assert.ok(!INTRO_SEEN_KEY.includes("user"));
  assert.ok(!INTRO_SEEN_KEY.includes("shop"));
});

test("the preview link is explicit and cannot accidentally match a normal launch", () => {
  assert.equal(isIntroPreviewUrl("https://idukaa-api.vercel.app/?intro=preview"), true);
  assert.equal(isIntroPreviewUrl("https://idukaa-api.vercel.app/?intro=preview&lang=en"), true);
  assert.equal(isIntroPreviewUrl("shopmgmt:///?intro=preview"), true);
  assert.equal(isIntroPreviewUrl("shopmgmt://intro-preview"), true);
  assert.equal(isIntroPreviewUrl("https://idukaa-api.vercel.app/"), false);
  assert.equal(isIntroPreviewUrl("https://idukaa-api.vercel.app/?intro=previewer"), false);
  assert.equal(isIntroPreviewUrl("shopmgmt:///stock"), false);
  assert.equal(isIntroPreviewUrl(null), false);
});

test("the preview is build-time gated and never overwrites the real completion flag", () => {
  const layout = read("app/_layout.tsx");
  const service = read("src/services/intro.ts");
  assert.match(service, /EXPO_PUBLIC_INTRO_PREVIEW/, "only a development/test build may expose it");
  assert.match(layout, /INTRO_PREVIEW_ENABLED/);
  assert.match(layout, /introPreview\.current = isIntroPreviewUrl\(launchUrl\)/);
  assert.match(layout, /introPreview\.current\s*\? false\s*:/, "a preview must not read the real flag as completion");
  assert.match(layout, /if \(introPreview\.current\) return;/, "preview completion must skip the KV write");
});

test("the intro tells the shop story with local, recognisable illustrations", () => {
  const intro = read("src/components/brand-intro.tsx");
  assert.match(intro, /function ShopBackdrop/);
  assert.match(intro, /function DeliveryActor/);
  assert.match(intro, /function InventoryActor/);
  assert.match(intro, /function SaleActor/);
  assert.match(intro, /kind[=:]\s*"rice"/, "rice bags must be visibly stocked");
  assert.match(intro, /kind[=:]\s*"bottle"/, "bottles must be visibly stocked");
  assert.match(intro, /kind[=:]\s*"carton"/, "cartons must be visibly stocked");
  assert.match(intro, /IDUKAA/);
  assert.doesNotMatch(intro, /GhostTile/, "the generic placeholder tiles must be gone");
  assert.match(intro, /minHeight: 112/, "the caption needs its own stable area");
  assert.match(intro, /const captionSize = cardWidth >= 500 \? 17 : 16/, "captions must scale up on wide screens");
  assert.match(intro, /fontSize: captionSize, lineHeight: captionSize \+ 7/, "captions must stay at the readable body size");
  assert.match(intro, /testID="intro-skip"/, "Skip must always be available");
  assert.match(intro, /introDurationFor/, "the component must use the tested timing rules");
  assert.doesNotMatch(intro, /https?:\/\//, "no remote animation or image service");
});

test("the requested English and Kinyarwanda captions are present", () => {
  const en = read("src/localization/en.ts");
  const rw = read("src/localization/rw.ts");
  assert.match(en, /"intro\.step1Title": "Stock in"/);
  assert.match(en, /"intro\.step1Text": "Receive products into your shop\."/);
  assert.match(en, /"intro\.step2Title": "Inventory management"/);
  assert.match(en, /"intro\.step2Text": "Track products and available stock\."/);
  assert.match(en, /"intro\.step3Title": "Sales & stock out"/);
  assert.match(en, /"intro\.step3Text": "Record sales and monitor stock movement\."/);
  assert.match(en, /"intro\.tagline": "Manage your shop\. Understand your business\."/);
  assert.match(rw, /"intro\.tagline": "Cunga iduka ryawe\. Menya uko ubucuruzi bwawe buhagaze\."/);
});

test("the brand intro is mounted only by the root layout", () => {
  const layout = read("app/_layout.tsx");
  assert.match(layout, /<BrandIntro mode=\{intro\} onDone=\{finishIntro\}/);
  assert.match(layout, /INTRO_SEEN_KEY/);
  for (const screen of ["app/login.tsx", "app/(app)/_layout.tsx", "app/(app)/index.tsx"]) {
    assert.doesNotMatch(read(screen), /BrandIntro/, `${screen} must not mount the intro`);
  }
});
