import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Request-scoped administrative access context.
 *
 * The AuthGuard decides whether a request is running inside an administrative impersonation
 * session and stores this object. The interceptor runs the downstream handler inside the
 * AsyncLocalStorage scope, so every audit() call made by any business service on that request is
 * written with the ORIGINAL administrator as actor — never as the target user.
 *
 * Keeping this out of controllers means no business service needs to know impersonation exists,
 * and no future endpoint can forget to attribute an action correctly.
 */
export interface ImpersonationContext {
  /** The authenticated system administrator. */
  adminId: string;
  sessionId: string;
  reason: string;
  /** Target user being managed, when the session targets a user account. */
  targetUserId: string | null;
  /** Target shop, always set once the session is resolved (from the user's shop or directly). */
  targetShopId: string | null;
  targetType: "user" | "shop";
  /** The role the administrator is exercising for this request. */
  effectiveRole: "owner" | "manager";
}

const storage = new AsyncLocalStorage<ImpersonationContext>();

export const runWithImpersonation = <T>(ctx: ImpersonationContext | null, fn: () => T): T =>
  ctx ? storage.run(ctx, fn) : fn();

export const currentImpersonation = (): ImpersonationContext | undefined => storage.getStore();
