import { BadRequestException, Body, Controller, Get, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { Me, Roles, type AuthUser } from "../common/auth";
import { OnboardingService } from "./onboarding.service";

const Uuid = z.string().uuid();
const Reason = z.object({ reason: z.string().trim().min(3).max(500) });
const Message = z.object({ message: z.string().trim().min(3).max(500) });
const Note = z.object({ note: z.string().trim().max(500).optional() }).optional();

/**
 * Owner application review. Role enforcement lives here (`@Roles("system_admin")`) and every
 * transition is re-checked by the service against the locked row, so a forged request from a
 * owner/manager token — or a stale double-click — can never produce a second decision.
 */
@Controller("admin/applications") @Roles("system_admin")
export class AdminApplicationsController {
  constructor(private onboarding: OnboardingService) {}

  @Get() list() { return this.onboarding.listApplications(); }

  @Get(":id") detail(@Param("id") id: string) { return this.onboarding.getApplication(parseId(id)); }

  @Post(":id/approve") approve(@Me() u: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    const b = Note.safeParse(body ?? {});
    return this.onboarding.approve(u.id, parseId(id), b.success ? b.data?.note : undefined);
  }

  @Post(":id/reject") reject(@Me() u: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    const b = Reason.safeParse(body);
    if (!b.success) throw new BadRequestException("reason_required");
    return this.onboarding.reject(u.id, parseId(id), b.data.reason);
  }

  @Post(":id/request-info") requestInfo(@Me() u: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    const b = Message.safeParse(body);
    if (!b.success) throw new BadRequestException("message_required");
    return this.onboarding.requestInformation(u.id, parseId(id), b.data.message);
  }

  /** Re-opens the 7-day activation window for an approved application whose window lapsed. */
  @Post(":id/activation-window") extendWindow(@Me() u: AuthUser, @Param("id") id: string) {
    return this.onboarding.extendActivationWindow(u.id, parseId(id));
  }
}

function parseId(id: string) {
  const r = Uuid.safeParse(id);
  if (!r.success) throw new BadRequestException("invalid_id");
  return r.data;
}
