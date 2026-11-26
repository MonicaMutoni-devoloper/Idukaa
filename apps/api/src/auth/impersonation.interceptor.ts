import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Observable } from "rxjs";
import { runWithImpersonation, type ImpersonationContext } from "./impersonation-context";

/**
 * Establishes the AsyncLocalStorage scope for one request. The AuthGuard has already validated the
 * session and attached it to `req.impersonationContext`; everything downstream — including every
 * audit() call in the business services — sees the administrator as the actor.
 */
@Injectable()
export class ImpersonationContextInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest();
    const impersonation = (req.impersonationContext ?? null) as ImpersonationContext | null;
    if (!impersonation) return next.handle();
    // Observable laziness: the handler must be created inside the ALS scope, so subscribe within it.
    return new Observable((subscriber) => {
      runWithImpersonation(impersonation, () => {
        next.handle().subscribe(subscriber);
      });
    });
  }
}
