import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { Db } from "./db/db.service";
import { AuthGuard } from "./common/auth";
import { Filter } from "./common/errors";
import { HealthController } from "./common/health.controller";
import { AppVersionController } from "./app-version/app-version.controller";
import { AuthController } from "./auth/auth.controller";
import { AuthService } from "./auth/auth.service";
import { AdminController } from "./auth/admin.controller";
import { NotificationsController } from "./notifications/notifications.controller";
import { NotificationService } from "./notifications/notifications.service";
import { SyncController } from "./sync/sync.controller";
import { SyncService } from "./sync/sync.service";
import { ReportsController } from "./reports/reports.controller";
import { ProfitabilityController } from "./reports/profitability.controller";
import { FinanceService } from "./reports/finance.service";
import { AuditsController } from "./audits/audits.controller";
import { PurchasesController } from "./purchases/purchases.controller";
import { SalesController } from "./sales/sales.controller";
import { ShopController } from "./shop/shop.controller";
import { StaffController } from "./shop/staff.controller";
import { OnboardingService } from "./onboarding/onboarding.service";
import { ApplicationsController } from "./onboarding/applications.controller";
import { AdminApplicationsController } from "./onboarding/admin-applications.controller";
import { StaffInvitationsController } from "./onboarding/staff-invitations.controller";
import { SubscriptionsController } from "./subscriptions/subscriptions.controller";
import { ShopMembershipsController } from "./shop/memberships.controller";
import { CustomersController } from "./customers/customers.controller";
import { AlertsController } from "./alerts/alerts.controller";

@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 240 }]),
    JwtModule.register({ global: true, secret: process.env.JWT_SECRET, signOptions: { expiresIn: process.env.JWT_EXPIRES_IN ?? "15m" } }),
  ],
  controllers: [HealthController, AppVersionController, AuthController, AdminController, NotificationsController, SyncController, ReportsController, ProfitabilityController, AuditsController, PurchasesController, SalesController, ShopController, StaffController, ApplicationsController, AdminApplicationsController, StaffInvitationsController, SubscriptionsController, ShopMembershipsController, CustomersController, AlertsController],
  providers: [
    Db, SyncService, AuthService, NotificationService, FinanceService, OnboardingService,
    { provide: APP_GUARD, useClass: ThrottlerGuard }, { provide: APP_GUARD, useClass: AuthGuard },
    // Global error handling (ZodError -> 400, no leaked internals) lives in the module so the
    // integration tests — which build AppModule without main.ts's bootstrap — see identical behaviour.
    { provide: APP_FILTER, useValue: new Filter() },
  ],
})
export class AppModule {}
