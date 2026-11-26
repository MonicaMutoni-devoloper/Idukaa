import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException, createParamDecorator } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import type { Role } from "@sms/shared";
import { Db } from "../db/db.service";
import { authLog } from "./auth-log";
import { ImpersonationService } from "../auth/impersonation.service";
import type { ImpersonationContext } from "../auth/impersonation-context";

export interface AuthUser { id: string; role: Role; shopId: string | null; subscriptionStatus?: string | null }
/** The role that applies to the user's active shop. Membership is authoritative; users.role is only the denormalized copy used when the account has no shop (system administration). */
export function activeShopRole(u: { shop_id?: string | null; role: Role; membership_role?: Role | null }): Role {
  return u.shop_id ? (u.membership_role ?? u.role) : u.role;
}
export const Roles = (...r: Role[]) => SetMetadata("roles", r);
export const Public = () => SetMetadata("public", true);
export const Me = createParamDecorator((_d, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user);

/** Verifies JWT AND re-checks the user row each request so revoked accounts / bumped token_version die immediately. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private jwt: JwtService, private db: Db, private ref: Reflector, private impersonation: ImpersonationService) {}

  async canActivate(ctx: ExecutionContext) {
    if (this.ref.getAllAndOverride<boolean>("public", [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest();
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!token) {
      authLog(req, "guard.rejected", "invalid_access_token", { detail: "missing_bearer" });
      throw new UnauthorizedException();
    }
    let p: any;
    try { p = await this.jwt.verifyAsync(token); }
    catch (e) {
      // Never log the token; the JWT library's error name is enough to tell an expiry from a bad signature.
      authLog(req, "guard.rejected", (e as Error)?.name === "TokenExpiredError" ? "token_expired" : "invalid_access_token",
        { detail: (e as Error)?.name ?? "verify_failed" });
      throw new UnauthorizedException("session_expired");
    }
    const [u] = await this.db.query(
      `SELECT u.id, u.role, u.shop_id, u.active, u.account_status, u.token_version, s.status AS shop_status,
            s.subscription_required,
            (SELECT ss.status FROM shop_subscriptions ss WHERE ss.shop_id=u.shop_id ORDER BY ss.created_at DESC LIMIT 1) AS subscription_status,
            (SELECT ss.ends_at FROM shop_subscriptions ss WHERE ss.shop_id=u.shop_id ORDER BY ss.created_at DESC LIMIT 1) AS subscription_ends_at,
            (SELECT m.role FROM shop_memberships m WHERE m.user_id=u.id AND m.shop_id=u.shop_id AND m.status='active') AS membership_role,
            EXISTS(SELECT 1 FROM shop_memberships m WHERE m.user_id=u.id AND m.shop_id=u.shop_id AND m.status='active') AS has_membership
         FROM users u LEFT JOIN shops s ON s.id = u.shop_id WHERE u.id=$1`, [p.sub]);
    if (!u || !u.active || u.account_status !== "active") {
      authLog(req, "guard.rejected", "session_revoked", { userId: p.sub, active: !!u?.active, accountStatus: u?.account_status });
      throw new UnauthorizedException("session_revoked");
    }
    if (u.token_version !== p.tv) {
      authLog(req, "guard.rejected", "session_state_mismatch", { userId: u.id });
      throw new UnauthorizedException("session_revoked");
    }
    // A suspended shop accepts no new activity even from a session that predates the suspension:
    // reads stay available so nothing on screen breaks, but every write fails with the real reason.
    // (system_admins have no shop and are unaffected; sign-in for suspended shops is refused in login.)
    if (u.shop_id && u.shop_status === "suspended" && req.method !== "GET") {
      authLog(req, "guard.rejected", "shop_suspended", { userId: u.id });
      throw new ForbiddenException("shop_suspended");
    }
    // A user is authorized for the active shop only through an explicit membership. The migration
    // backfills every existing account, so a missing row is a real isolation failure, not a legacy
    // state that may be guessed past.
    if (u.shop_id && u.has_membership !== true) {
      authLog(req, "guard.rejected", "shop_membership_missing", { userId: u.id, shopId: u.shop_id });
      throw new ForbiddenException("shop_access_denied");
    }
    const path = String(req.path ?? req.url ?? "").split("?")[0] ?? "";
    const subscriptionExempt = path.startsWith("/auth") || path.startsWith("/subscriptions")
      || path.startsWith("/shop/memberships") || path.startsWith("/shop/switch")
      || (req.method === "GET" && path === "/shop/profile")
      || path === "/health" || path.startsWith("/app-version");
    // Paid functionality requires a server-confirmed active subscription. Reading the shop list,
    // plan catalog and renewal screen stays available so the owner can resolve the state.
    const subscriptionActive = u.subscription_status === "active"
      && (!u.subscription_ends_at || new Date(u.subscription_ends_at).getTime() > Date.now());
    if (u.shop_id && u.subscription_required && !subscriptionActive && !subscriptionExempt) {
      authLog(req, "guard.rejected", "subscription_inactive", { userId: u.id, shopId: u.shop_id, status: u.subscription_status ?? "missing" });
      throw new ForbiddenException("subscription_inactive");
    }

    // ---- ADMINISTRATIVE ACCESS (IMPERSONATION) ----
    // Session-management routes always run as the administrator, never as a target. A target header
    // on those routes is ignored so /admin/impersonation/end can revoke the session it belongs to.
    const isSessionManagement = path.startsWith("/admin/impersonation");
    const presentedSession = req.headers["x-impersonation-session"];
    const sessionId = typeof presentedSession === "string" && presentedSession.length > 0 ? presentedSession : undefined;

    let role = activeShopRole(u);
    let context: ImpersonationContext | null = null;

    if (!isSessionManagement) {
      if (sessionId) {
        const valid = await this.impersonation.validateImpersonationSession(u.id, sessionId);
        if (!valid) {
          // An expired, revoked, mismatched or unauthorized session is never silently downgraded to
          // the administrator's own account: the caller must exit/re-enter explicitly.
          authLog(req, "guard.rejected", "impersonation_invalid", { userId: u.id, detail: "session_not_valid" });
          throw new ForbiddenException("impersonation_invalid");
        }

        if (valid.targetType === "user") {
          const [target] = await this.db.query(
            `SELECT u.id, u.email, u.full_name, u.role, u.shop_id, u.active, u.account_status,
                    s.name AS shop_name, s.status AS shop_status,
                    (SELECT m.role FROM shop_memberships m
                      WHERE m.user_id=u.id AND m.shop_id=u.shop_id AND m.status='active') AS membership_role
               FROM users u LEFT JOIN shops s ON s.id=u.shop_id WHERE u.id=$1`, [valid.targetId]);
          if (!target || !target.active || target.account_status !== "active"
              || target.role === "system_admin" || !target.shop_id || target.shop_status !== "active") {
            authLog(req, "guard.rejected", "impersonation_invalid", { userId: u.id, detail: "target_unavailable" });
            throw new ForbiddenException("impersonation_target_unavailable");
          }
          const targetRole = activeShopRole(target);
          if (targetRole === "system_admin") throw new ForbiddenException("impersonation_target_unavailable");
          role = targetRole;
          // Writes are attributed to the administrator, not to the account owner. The target's role
          // and shop are used for permissions and tenant scope only; /auth/me returns the target
          // identity separately so the interface still looks like the accessed account.
          req.user = { id: u.id, role, shopId: target.shop_id, subscriptionStatus: "active" } satisfies AuthUser;
          context = {
            adminId: u.id, sessionId, reason: valid.reason,
            targetUserId: target.id, targetShopId: target.shop_id,
            targetType: "user", effectiveRole: targetRole as "owner" | "manager",
          };
          req.impersonatedUser = {
            id: target.id, email: target.email, name: target.full_name, role: targetRole,
            shopId: target.shop_id, shopName: target.shop_name ?? null,
          };
          req.impersonatedShop = { id: target.shop_id, name: target.shop_name ?? null };
        } else {
          const [shop] = await this.db.query("SELECT id, name, currency, status, created_at FROM shops WHERE id=$1", [valid.targetId]);
          if (!shop || shop.status !== "active") throw new ForbiddenException("impersonation_target_unavailable");
          role = "owner";
          // The administrator remains the actor; the shop is only the scope being worked in.
          req.user = { id: u.id, role, shopId: shop.id, subscriptionStatus: "active" } satisfies AuthUser;
          context = {
            adminId: u.id, sessionId, reason: valid.reason,
            targetUserId: null, targetShopId: shop.id,
            targetType: "shop", effectiveRole: "owner",
          };
          req.impersonatedShop = { id: shop.id, name: shop.name, currency: shop.currency, status: shop.status, createdAt: shop.created_at };
        }
        req.impersonationContext = context;
        req.adminUser = { id: u.id, name: null, role: u.role };
      } else {
        req.user = { id: u.id, role, shopId: u.shop_id, subscriptionStatus: subscriptionActive ? "active" : (u.subscription_status ?? null) } satisfies AuthUser;
        req.impersonationContext = null;
      }
    } else {
      req.user = { id: u.id, role, shopId: u.shop_id, subscriptionStatus: subscriptionActive ? "active" : (u.subscription_status ?? null) } satisfies AuthUser;
      req.impersonationContext = null;
    }

    // Platform-level controls and credentials are never available through an impersonated session.
    if (context) {
      const adminSurface = path.startsWith("/admin") && path !== "/admin/impersonation/end";
      const credentialSurface = path.startsWith("/auth/password") || path.startsWith("/auth/2fa")
        || path.startsWith("/auth/logout") || (path === "/auth/me" && req.method !== "GET")
        || path.startsWith("/subscriptions") || path.startsWith("/shop/memberships")
        || path.startsWith("/shop/switch");
      if (adminSurface || credentialSurface) {
        authLog(req, "guard.rejected", "impersonation_invalid", { userId: u.id, detail: "forbidden_surface", path });
        throw new ForbiddenException("not_allowed_during_impersonation");
      }
    }

    const need = this.ref.getAllAndOverride<Role[]>("roles", [ctx.getHandler(), ctx.getClass()]);
    if (need && !need.includes(role)) {
      authLog(req, "guard.rejected", "role_not_allowed", { userId: u.id, role });
      throw new ForbiddenException("role_not_allowed");
    }
    return true;
  }
}
