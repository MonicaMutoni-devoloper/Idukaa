/**
 * Business-alert workflow rules, shared by the API (authoritative) and the app (so a button is
 * never offered for an action the server will refuse).
 *
 * An alert is a review prompt, not a verdict. It moves DETECTED → OPEN → UNDER INVESTIGATION →
 * ACTION REQUIRED / ESCALATED → RESOLVED, and every move is recorded with who made it, when, and
 * why. Nothing here touches the sale, stock movement or expense an alert points at: correcting a
 * transaction is a separate, auditable decision.
 */
export const AlertStatuses = ["open", "investigating", "action_required", "escalated", "resolved", "legitimate"] as const;
export type AlertStatus = (typeof AlertStatuses)[number];

/** `legitimate` predates this workflow; it is a resolved alert and is read as one everywhere. */
export type DisplayStatus = "open" | "investigating" | "action_required" | "escalated" | "resolved";

export function displayStatus(status: string): DisplayStatus {
  if (status === "legitimate") return "resolved";
  return (AlertStatuses.includes(status as AlertStatus) ? status : "open") as DisplayStatus;
}

export function isClosed(status: string): boolean {
  return displayStatus(status) === "resolved";
}

/** Allowed moves. Resolving is reachable from every live state; reopening is its own action. */
const TRANSITIONS: Record<DisplayStatus, DisplayStatus[]> = {
  open: ["investigating", "action_required", "escalated", "resolved"],
  investigating: ["action_required", "escalated", "resolved"],
  action_required: ["investigating", "escalated", "resolved"],
  escalated: ["investigating", "resolved"],
  resolved: ["open"], // reopen
};

export function canTransition(from: string, to: string): boolean {
  const a = displayStatus(from), b = displayStatus(to);
  return a !== b && TRANSITIONS[a].includes(b);
}

export const AlertActions = ["investigate", "assign", "note", "escalate", "resolve", "reopen"] as const;
export type AlertAction = (typeof AlertActions)[number];

/**
 * Managers investigate and close ordinary cases; opening a decision that approves an exception, or
 * reopening a closed investigation, is the owner's call.
 */
export function mayPerform(role: "owner" | "manager" | "system_admin", action: AlertAction): boolean {
  if (role === "system_admin") return false;
  if (role === "owner") return true;
  return action !== "reopen";
}

export const ResolutionCategories = ["approved_activity", "human_error", "suspicious_activity", "false_positive", "other"] as const;
export type ResolutionCategory = (typeof ResolutionCategories)[number];

/** Which resolutions a role may record. Managers cannot sign off an exception as approved. */
export function categoriesForRole(role: "owner" | "manager" | "system_admin"): readonly ResolutionCategory[] {
  if (role === "owner") return ResolutionCategories;
  if (role === "manager") return ["human_error", "false_positive", "other", "suspicious_activity"];
  return [];
}

/** The activity suspected of being improper must be looked at, never silently written off. */
export const EscalatingCategories: readonly ResolutionCategory[] = ["suspicious_activity"];

export const SeverityLevels = ["critical", "high", "medium", "low"] as const;
export type SeverityLevel = (typeof SeverityLevels)[number];

/** Older alerts only carry info/warning/critical; map them onto the four review levels. */
export function severityLevel(stored: string | null | undefined, level?: string | null): SeverityLevel {
  if (level && (SeverityLevels as readonly string[]).includes(level)) return level as SeverityLevel;
  switch (stored) {
    case "critical": return "critical";
    case "warning": return "high";
    case "info": return "medium";
    default: return "medium";
  }
}

/** An alert that was never opened for investigation is still simply open. */
export function nextStatusForAction(action: Exclude<AlertAction, "resolve" | "reopen" | "note" | "assign">): DisplayStatus {
  return action === "investigate" ? "investigating" : "escalated";
}
