import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canTransition, categoriesForRole, displayStatus, isClosed, mayPerform, severityLevel,
} from "../src/index.ts";

test("the workflow moves forward and refuses invented jumps", () => {
  assert.equal(canTransition("open", "investigating"), true);
  assert.equal(canTransition("open", "escalated"), true);
  assert.equal(canTransition("investigating", "action_required"), true);
  assert.equal(canTransition("escalated", "resolved"), true);
  assert.equal(canTransition("resolved", "open"), true);        // reopen
  assert.equal(canTransition("open", "resolved"), true);        // a quick, documented closure
  assert.equal(canTransition("resolved", "escalated"), false);  // nothing to escalate
  assert.equal(canTransition("open", "open"), false);
});

test("legacy 'legitimate' alerts read as resolved everywhere", () => {
  assert.equal(displayStatus("legitimate"), "resolved");
  assert.equal(isClosed("legitimate"), true);
  assert.equal(displayStatus("escalated"), "escalated");
  assert.equal(displayStatus("nonsense"), "open");
});

test("managers investigate and close ordinary cases, but do not reopen or approve exceptions", () => {
  assert.equal(mayPerform("manager", "investigate"), true);
  assert.equal(mayPerform("manager", "resolve"), true);
  assert.equal(mayPerform("manager", "reopen"), false);
  assert.equal(mayPerform("owner", "reopen"), true);
  assert.equal(mayPerform("system_admin", "resolve"), false); // no shop role, no shop decision
  assert.deepEqual(categoriesForRole("manager"), ["human_error", "false_positive", "other", "suspicious_activity"]);
  assert.equal(categoriesForRole("manager").includes("approved_activity"), false);
  assert.equal(categoriesForRole("owner").includes("approved_activity"), true);
});

test("old severities map onto the four review levels", () => {
  assert.equal(severityLevel("critical"), "critical");
  assert.equal(severityLevel("warning"), "high");
  assert.equal(severityLevel("info"), "medium");
  assert.equal(severityLevel("warning", "low"), "low");     // stored level wins
  assert.equal(severityLevel(null, "nonsense"), "medium");  // never invents a level
});
