import { BadRequestException, Body, Controller, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { Me, Public, type AuthUser } from "../common/auth";
import { OnboardingService } from "./onboarding.service";

const Token = z.object({ token: z.string().min(20).max(500) });
const Accept = Token.extend({ password: z.string().min(1).max(200) });

/**
 * Manager invitation acceptance. The link is shared by the owner (no e-mail provider is
 * configured, and the UI says so). A brand-new manager picks their own password here; an address
 * that already has an account must be signed in first, so an invitation can never quietly move
 * somebody else's account into another shop.
 */
@Controller("staff-invitations")
export class StaffInvitationsController {
  constructor(private onboarding: OnboardingService) {}

  @Public() @Throttle({ default: { limit: 20, ttl: 60_000 } }) @Post("preview")
  preview(@Body() body: unknown) {
    const b = Token.safeParse(body);
    if (!b.success) throw new BadRequestException("invitation_invalid");
    return this.onboarding.previewInvitation(b.data.token);
  }

  @Public() @Throttle({ default: { limit: 10, ttl: 60_000 } }) @Post("accept")
  accept(@Body() body: unknown) {
    const b = Accept.safeParse(body);
    if (!b.success) throw new BadRequestException(b.error.issues[0]?.message);
    return this.onboarding.acceptInvitation(b.data.token, b.data.password);
  }

  /** Requires a real session: the signed-in account must own the invited email address. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } }) @Post("accept-auth")
  acceptAuthenticated(@Me() u: AuthUser, @Body() body: unknown) {
    const b = Token.safeParse(body);
    if (!b.success) throw new BadRequestException("invitation_invalid");
    return this.onboarding.acceptInvitationAuthenticated(u, b.data.token);
  }
}
