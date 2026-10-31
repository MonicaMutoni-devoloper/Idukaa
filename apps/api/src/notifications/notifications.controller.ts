import { BadRequestException, Body, Controller, Get, Post, Put } from "@nestjs/common";
import { z } from "zod";
import { Me, type AuthUser } from "../common/auth";
import { NotificationService } from "./notifications.service";

const Patch = z.object({
  lowStock: z.boolean().optional(),
  outOfStock: z.boolean().optional(),
  salesActivity: z.boolean().optional(),
  inventoryUpdates: z.boolean().optional(),
}).strict();

const ReadBody = z.object({ ids: z.array(z.string().uuid()).max(200).optional() });

/** Every route is scoped to the authenticated user; no client-supplied user id is ever trusted. */
@Controller("notifications")
export class NotificationsController {
  constructor(private notifications: NotificationService) {}

  @Get()
  inbox(@Me() u: AuthUser) { return this.notifications.inbox(u.id, u.shopId); }

  @Post("read")
  read(@Me() u: AuthUser, @Body() body: unknown) {
    const b = ReadBody.safeParse(body ?? {});
    if (!b.success) throw new BadRequestException(b.error.issues[0]?.message);
    return this.notifications.markRead(u.id, b.data.ids);
  }

  @Get("preferences")
  preferences(@Me() u: AuthUser) { return this.notifications.preferences(u.id); }

  @Put("preferences")
  save(@Me() u: AuthUser, @Body() body: unknown) {
    const b = Patch.safeParse(body);
    if (!b.success) throw new BadRequestException(b.error.issues[0]?.message);
    return this.notifications.savePreferences(u.id, b.data);
  }
}
