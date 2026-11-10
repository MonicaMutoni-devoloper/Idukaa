/**
 * Pure rules for the dashboard's private cache and its change marker.
 *
 * Kept free of React Native and database imports so Node tests can prove the two properties that
 * matter: a cache is never shared across accounts/shops/roles, and a cached copy is only treated
 * as current when the last successful pull saw the same server business revision.
 */

export interface DashboardIdentity {
  id?: string | null;
  shopId?: string | null;
  role?: string | null;
}

export interface DashboardCacheMeta {
  savedAt?: unknown;
  revision?: unknown;
  version?: unknown;
}

/** The part of a session that can make cached figures belong to somebody else. */
export const dashboardScope = (user: DashboardIdentity | null | undefined) =>
  `${user?.shopId ?? "none"}:${user?.id ?? "none"}:${user?.role ?? "none"}`;

/** Versioned so a cached payload from an older shape is never rendered as current. */
export const dashboardCacheKey = (
  user: DashboardIdentity | null | undefined,
  from: string,
  to: string,
) => `dashboard:v3:${dashboardScope(user)}:${from}:${to}`;

/** One marker per shop: switching accounts inside the same shop keeps the same business state. */
export const businessRevisionKey = (shopId: string | null | undefined) => `bizrev:${shopId ?? "none"}`;

/**
 * True only when the saved copy came from the same business revision and has a valid timestamp.
 * A missing revision (older build or older server) always revalidates instead of claiming freshness.
 */
export function dashboardCacheIsCurrent(entry: DashboardCacheMeta | null, currentRevision: string | null): boolean {
  if (!entry || !currentRevision) return false;
  if (entry.version !== 3) return false;
  if (typeof entry.revision !== "string" || entry.revision !== currentRevision) return false;
  return typeof entry.savedAt === "string" && !Number.isNaN(Date.parse(entry.savedAt));
}
