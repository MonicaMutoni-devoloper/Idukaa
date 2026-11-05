import type { Role } from "@sms/shared";
import type { Key } from "./localization";

export interface NavItem { href: string; key: Key; description?: Key }
export interface NavGroup { label: Key; items: NavItem[] }

/** One navigation definition per role, used by the desktop sidebar, the phone tab bar and More. */
export const NAV: Record<Role, NavGroup[]> = {
  manager: [
    { label: "nav.groupOperations", items: [
      { href: "/", key: "nav.home", description: "nav.homeDesc" },
      { href: "/sell", key: "nav.sell", description: "nav.sellDesc" },
      { href: "/stock", key: "nav.stock", description: "nav.stockDesc" },
    ] },
    // Sales visibility: a manager sees the same shop activity as the owner (without cost/profit).
    { label: "nav.groupOversight", items: [
      { href: "/reports", key: "nav.reports", description: "nav.reportsDesc" },
    ] },
    { label: "nav.groupAdmin", items: [
      { href: "/expense", key: "nav.expense", description: "nav.expenseDesc" },
      { href: "/sync", key: "nav.sync", description: "nav.syncDesc" },
      { href: "/notifications", key: "nav.notifications", description: "nav.notificationsDesc" },
      { href: "/security", key: "nav.security", description: "nav.securityDesc" },
      { href: "/settings", key: "nav.settings", description: "nav.settingsDesc" },
    ] },
  ],
  owner: [
    // The owner does the same day-to-day work a manager does — selling and receiving stock — so
    // those destinations come first. Without this group the owner could record a sale only through
    // a dashboard shortcut, never from the navigation a manager uses.
    { label: "nav.groupOperations", items: [
      { href: "/sell", key: "nav.sell", description: "nav.sellDesc" },
      { href: "/stock", key: "nav.stock", description: "nav.stockDesc" },
    ] },
    { label: "nav.groupOversight", items: [
      { href: "/", key: "nav.home", description: "nav.homeDesc" },
      { href: "/reports", key: "nav.reports", description: "nav.reportsDesc" },
      { href: "/profitability", key: "nav.profitability", description: "nav.profitabilityDesc" },
      { href: "/approvals", key: "nav.approvals", description: "nav.approvalsDesc" },
    ] },
    { label: "nav.groupAdmin", items: [
      { href: "/expense", key: "nav.expense", description: "nav.expenseDesc" },
      { href: "/team", key: "nav.team", description: "nav.teamDesc" },
      { href: "/sync", key: "nav.sync", description: "nav.syncDesc" },
      { href: "/notifications", key: "nav.notifications", description: "nav.notificationsDesc" },
      { href: "/security", key: "nav.security", description: "nav.securityDesc" },
      { href: "/settings", key: "nav.settings", description: "nav.settingsDesc" },
    ] },
  ],
  system_admin: [
    { label: "nav.groupSystem", items: [
      { href: "/admin", key: "admin.overview", description: "admin.overviewDesc" },
      { href: "/admin/applications", key: "admin.applications", description: "admin.applicationsDesc" },
      { href: "/admin/shops", key: "admin.shops", description: "admin.shopsDesc" },
      { href: "/admin/users", key: "admin.users", description: "admin.usersDesc" },
      { href: "/admin/audit", key: "admin.auditNav", description: "admin.auditNavDesc" },
      { href: "/admin/health", key: "admin.health", description: "admin.healthDesc" },
      { href: "/notifications", key: "nav.notifications", description: "nav.notificationsDesc" },
      { href: "/security", key: "nav.security", description: "nav.securityDesc" },
      { href: "/settings", key: "nav.settings", description: "nav.settingsDesc" },
    ] },
  ],
};

export const allNav = (role: Role): NavItem[] => NAV[role].flatMap((g) => g.items);

/** Phone tab bar: at most five slots. Extra destinations live behind More. */
export function bottomNav(role: Role): NavItem[] {
  const items = allNav(role);
  if (items.length <= 5) return items;
  return [...items.slice(0, 4), { href: "/more", key: "nav.more", description: "nav.moreDesc" }];
}

export function secondaryNav(role: Role): NavItem[] {
  const primary = new Set(bottomNav(role).map((i) => i.href));
  return allNav(role).filter((i) => !primary.has(i.href));
}

const isActive = (href: string, path: string) => (href === "/" ? path === "/" : href === "/admin" ? path === "/admin" : path === href || path.startsWith(`${href}/`));

export const activeNav = (href: string, path: string) => isActive(href, path);
