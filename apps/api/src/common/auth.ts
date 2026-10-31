import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException, createParamDecorator } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import type { Role } from "@sms/shared";
import { Db } from "../db/db.service";

export interface AuthUser { id: string; role: Role; shopId: string | null }
export const Roles = (...r: Role[]) => SetMetadata("roles", r);
export const Public = () => SetMetadata("public", true);
export const Me = createParamDecorator((_d, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user);

/** Verifies JWT AND re-checks the user row each request so revoked accounts / bumped token_version die immediately. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private jwt: JwtService, private db: Db, private ref: Reflector) {}
  async canActivate(ctx: ExecutionContext) {
    if (this.ref.getAllAndOverride<boolean>("public", [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest();
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!token) throw new UnauthorizedException();
    let p: any; try { p = await this.jwt.verifyAsync(token); } catch { throw new UnauthorizedException("session_expired"); }
    const [u] = await this.db.query(
      `SELECT u.id, u.role, u.shop_id, u.active, u.account_status, u.token_version, s.status AS shop_status
         FROM users u LEFT JOIN shops s ON s.id = u.shop_id WHERE u.id=$1`, [p.sub]);
    if (!u || !u.active || u.account_status !== "active" || u.token_version !== p.tv) throw new UnauthorizedException("session_revoked");
    // A suspended shop accepts no new activity even from a session that predates the suspension:
    // reads stay available so nothing on screen breaks, but every write fails with the real reason.
    // (system_admins have no shop and are unaffected; sign-in for suspended shops is refused in login.)
    if (u.shop_id && u.shop_status === "suspended" && req.method !== "GET") throw new ForbiddenException("shop_suspended");
    req.user = { id: u.id, role: u.role, shopId: u.shop_id } satisfies AuthUser;
    const need = this.ref.getAllAndOverride<Role[]>("roles", [ctx.getHandler(), ctx.getClass()]);
    if (need && !need.includes(u.role)) throw new ForbiddenException("role_not_allowed");
    return true;
  }
}
