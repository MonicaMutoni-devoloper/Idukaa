import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { Me, Roles, type AuthUser } from "../common/auth";
import { SyncService } from "./sync.service";

// Batch shape only; each operation is validated individually so one bad op cannot block the queue.
const Batch = z.object({ operations: z.array(z.unknown()).min(1).max(100) });

@Controller("sync") @Roles("owner", "manager")
export class SyncController {
  constructor(private s: SyncService) {}
  @Post("push") async push(@Me() u: AuthUser, @Body() body: unknown) {
    const { operations } = Batch.parse(body);
    return { results: await this.s.push(u, "", operations) };
  }
  @Get("pull") pull(@Me() u: AuthUser, @Query("checkpoint") cp?: string) { return this.s.pull(u, cp); }
}
