import { BadRequestException, Body, Controller, Get, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { Me, Roles, type AuthUser } from "../common/auth";
import { OnboardingService } from "../onboarding/onboarding.service";

const Uuid = z.string().uuid();
const InviteBody = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(160),
  phone: z.string().trim().max(30).optional(),
});

/**
 * Team management for ONE shop. The shop always comes from the signed-in owner's own row — a
 * request can never name another shop, and the invitation's role column is fixed to `manager`,
 * so this surface cannot mint an owner or a system administrator.
 */
@Controller("shop/staff") @Roles("owner")
export class StaffController {
  constructor(private onboarding: OnboardingService) {}

  @Get() list(@Me() u: AuthUser) { return this.onboarding.listStaff(u); }

  @Post("invitations") invite(@Me() u: AuthUser, @Body() body: unknown) {
    const b = InviteBody.safeParse(body);
    if (!b.success) throw new BadRequestException(b.error.issues[0]?.message);
    return this.onboarding.invite(u, b.data);
  }

  @Post("invitations/:id/resend") resend(@Me() u: AuthUser, @Param("id") id: string) {
    return this.onboarding.resendInvitation(u, parseId(id));
  }

  @Post("invitations/:id/revoke") revoke(@Me() u: AuthUser, @Param("id") id: string) {
    return this.onboarding.revokeInvitation(u, parseId(id));
  }
}

function parseId(id: string) {
  const r = Uuid.safeParse(id);
  if (!r.success) throw new BadRequestException("invalid_id");
  return r.data;
}
