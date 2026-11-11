/**
 * The introduction is a one-time product surface, so its timing and storage contract are checked
 * here instead of being left as loose numbers inside a component.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  INTRO_FIRST_MS, INTRO_REDUCED_FIRST_MS, INTRO_REDUCED_RETURNING_MS, INTRO_RETURNING_MS,
  INTRO_SEEN_KEY, introDurationFor,
} from "../src/services/intro.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

test("first launch gets a 4–5 second introduction and later launches a 0.5–1 second transition", () => {
  assert.ok(introDurationFor("first", false) >= 4000 && introDurationFor("first", false) <= 5000);
  assert.ok(introDurationFor("returning", false) >= 500 && introDurationFor("returning", false) <= 1000);
  assert.equal(introDurationFor("first", false), INTRO_FIRST_MS);
  assert.equal(introDurationFor("returning", false), INTRO_RETURNING_MS);
  assert.equal(introDurationFor("loading", false), 0);
  assert.equal(introDurationFor("done", false), 0);
});

test("reduced motion keeps the first-launch reading time but never adds a second wait", () => {
  assert.equal(introDurationFor("first", true), INTRO_REDUCED_FIRST_MS);
  assert.equal(introDurationFor("returning", true), INTRO_REDUCED_RETURNING_MS);
  assert.ok(INTRO_REDUCED_FIRST_MS >= 4000 && INTRO_REDUCED_FIRST_MS <= 5000);
  assert.ok(INTRO_REDUCED_RETURNING_MS >= 500 && INTRO_REDUCED_RETURNING_MS <= 1000);
});

test("the completion flag is installation-wide and versioned", () => {
  assert.equal(INTRO_SEEN_KEY, "intro_seen_v1");
  assert.ok(!INTRO_SEEN_KEY.includes("user"));
  assert.ok(!INTRO_SEEN_KEY.includes("shop"));
});

test("the brand intro is local, skippable and mounted only by the root layout", () => {
  const intro = read("src/components/brand-intro.tsx");
  const layout = read("app/_layout.tsx");
  assert.match(intro, /testID="intro-skip"/, "Skip must always be available");
  assert.match(intro, /introDurationFor/, "the component must use the tested timing rules");
  assert.doesNotMatch(intro, /https?:\/\//, "no remote animation or image service");
  assert.match(layout, /<BrandIntro mode=\{intro\} onDone=\{finishIntro\}/);
  assert.match(layout, /INTRO_SEEN_KEY/);

  // A screen-level copy would replay the introduction on navigation, which the brief forbids.
  for (const screen of ["app/login.tsx", "app/(app)/_layout.tsx", "app/(app)/index.tsx"]) {
    assert.doesNotMatch(read(screen), /BrandIntro/, `${screen} must not mount the intro`);
  }
});
