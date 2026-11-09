/**
 * Update policy, kept free of React Native imports so it can be unit-tested on plain Node.
 *
 * Two questions are answered here and nowhere else:
 *  - may the app talk to this server at all (minimum API version), and
 *  - does the installed build need updating, optionally or unavoidably (minimum app version).
 *
 * Native versions are compared by `versionCode` when both sides have one, because that is what
 * Android itself uses to decide whether an APK upgrades an installed app; the dotted version is the
 * human-readable fallback. A manifest that is missing data is treated as "no update" — an update
 * prompt is a courtesy, never a reason to block a shop from selling.
 */
export interface UpdateManifest {
  apiVersion?: number;
  minimumApiVersion?: number;
  latest?: {
    version?: string;
    versionCode?: number;
    runtimeVersion?: string;
    url?: string;
    notes?: string;
    critical?: boolean;
  };
  minimum?: { version?: string; versionCode?: number };
  ota?: { enabled?: boolean };
}

export interface InstalledApp {
  version: string;
  versionCode: number;
}

export type UpdateVerdict =
  | { kind: "up-to-date" }
  | { kind: "optional" | "required"; latest: NonNullable<UpdateManifest["latest"]> };

/** How often an automatic check may run. Manual checks bypass this. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** `1.0.2` / `v1.2` / `1.0.2-beta.1` -> [1, 0, 2]; anything unparseable -> [] ("unknown"). */
export function parseVersion(value: string | undefined | null): number[] {
  const match = /^\s*v?(\d+(?:\.\d+)*)/i.exec(value ?? "");
  const digits = match?.[1];
  return digits ? digits.split(".").map(Number) : [];
}

/** -1 when a is older, 0 when equal, 1 when a is newer. Missing segments count as 0. */
export function compareVersions(a: string | undefined | null, b: string | undefined | null): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left.length || !right.length) return 0;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/** True when the installed build is older than a floor the server published. */
export function isOlderThan(installed: InstalledApp, floor: { version?: string; versionCode?: number } | undefined): boolean {
  if (!floor) return false;
  const theirCode = Number(floor.versionCode ?? 0);
  if (installed.versionCode > 0 && theirCode > 0) return installed.versionCode < theirCode;
  return compareVersions(installed.version, floor.version) < 0;
}

/** What the app should show for this manifest. */
export function decideUpdate(installed: InstalledApp, manifest: UpdateManifest | null | undefined): UpdateVerdict {
  const latest = manifest?.latest;
  if (!latest || !latest.version) return { kind: "up-to-date" };
  if (isOlderThan(installed, manifest?.minimum)) return { kind: "required", latest };
  // An optional update only makes sense if the server actually points somewhere to download it.
  if (isOlderThan(installed, { version: latest.version, versionCode: latest.versionCode }) && latest.url) {
    return { kind: "optional", latest };
  }
  return { kind: "up-to-date" };
}

/** False while the last automatic check is still fresh, so foreground/connectivity triggers stay quiet. */
export function shouldCheck(now: number, lastCheckAt: number | null | undefined, intervalMs = UPDATE_CHECK_INTERVAL_MS): boolean {
  const last = Number(lastCheckAt ?? 0);
  if (!Number.isFinite(last) || last <= 0) return true;
  // A clock that moved backwards must not silence checks forever.
  if (last > now) return true;
  return now - last >= intervalMs;
}

/** Older clients keep working while the backend moves on; only a refused API version stops them. */
export function apiCompatible(installedApiVersion: number, manifest: UpdateManifest | null | undefined): boolean {
  const minimum = Number(manifest?.minimumApiVersion ?? 0);
  return !(minimum > 0) || installedApiVersion >= minimum;
}
