import { BadRequestException, Body, Controller, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { Public } from "../common/auth";
import { passwordSchema } from "../auth/security";
import { OnboardingService } from "./onboarding.service";

const Submit = z.object({
  contactName: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(160),
  phone: z.string().trim().min(5).max(30),
  shopName: z.string().trim().min(2).max(120),
  // The five-field registration form does not ask for these; the service defaults them.
  location: z.string().trim().min(2).max(120).optional(),
  category: z.string().trim().min(2).max(60).optional(),
  note: z.string().trim().max(500).optional(),
  /** Chosen at registration. The server hashes it; approval activates the account directly. */
  password: passwordSchema.optional(),
});
const StatusBody = z.object({ statusToken: z.string().min(20).max(500) });
const RespondBody = StatusBody.extend({ message: z.string().trim().min(3).max(500) });
const ActivateBody = z.object({
  token: z.string().min(20).max(500).optional(),
  statusToken: z.string().min(20).max(500).optional(),
  password: z.string().min(1).max(200),
}).refine((v) => !!v.token || !!v.statusToken, { message: "activation_token_invalid" });

/**
 * Everything here is public but throttled: an applicant has no account yet. The status token
 * issued at submission is the only way in — an application is never reachable by id or by email.
 */
@Public() @Controller("applications")
export class ApplicationsController {
  constructor(private onboarding: OnboardingService) {}

  @Throttle({ default: { limit: 5, ttl: 60_000 } }) @Post()
  submit(@Body() body: unknown) {
    const b = Submit.safeParse(body);
    if (!b.success) throw new BadRequestException(b.error.issues[0]?.message);
    return this.onboarding.submitApplication(b.data);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } }) @Post("status")
  status(@Body() body: unknown) {
    const b = StatusBody.safeParse(body);
    if (!b.success) throw new BadRequestException("status_token_invalid");
    return this.onboarding.applicationStatus(b.data.statusToken);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } }) @Post("respond")
  respond(@Body() body: unknown) {
    const b = RespondBody.safeParse(body);
    if (!b.success) throw new BadRequestException(b.error.issues[0]?.message);
    return this.onboarding.respondToInformation(b.data.statusToken, b.data.message);
  }

  /** Activation: password policy is applied by the server, never only by the UI. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } }) @Post("activate")
  activate(@Body() body: unknown) {
    const b = ActivateBody.safeParse(body);
    if (!b.success) throw new BadRequestException(b.error.issues[0]?.message);
    return this.onboarding.activateOwner({ token: b.data.token, statusToken: b.data.statusToken }, b.data.password);
  }
}
