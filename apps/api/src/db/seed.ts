// Creates a DEMO shop + users for local development only. Passwords come from env, never hard-coded.
import "../env";
import { Pool } from "pg";
import bcrypt from "bcryptjs";

async function main() {
  // Hard stop: this script creates demo shops and demo users. It must never run against production,
  // whatever DATABASE_URL happens to point at (see docs/DEPLOYMENT.md).
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to seed demo data while NODE_ENV=production. Create real accounts through the onboarding flow instead.");
    process.exitCode = 1;
    return;
  }
  const pw = process.env.SEED_PASSWORD;
  if (!pw || pw.length < 10) { console.error("Set SEED_PASSWORD (min 10 chars)"); process.exitCode = 1; return; }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const hash = await bcrypt.hash(pw, 12);
  const shop = (await pool.query("INSERT INTO shops(name) SELECT 'Demo Shop (dev only)' WHERE NOT EXISTS (SELECT 1 FROM users WHERE email='owner@demo.local') RETURNING id")).rows[0]?.id;
  if (!shop) { console.log("Already seeded — nothing to do."); await pool.end(); return; }
  await pool.query("INSERT INTO users(shop_id,email,full_name,password_hash,role) VALUES ($1,'owner@demo.local','Demo Owner',$2,'owner'),($1,'manager@demo.local','Demo Manager',$2,'manager') ON CONFLICT (email) DO NOTHING", [shop, hash]);
  await pool.query("INSERT INTO users(email,full_name,password_hash,role) VALUES ('admin@demo.local','Demo Admin',$1,'system_admin') ON CONFLICT (email) DO NOTHING", [hash]);
  console.log("Seeded demo shop and 3 users (owner/manager/admin @demo.local).");
  await pool.end();
}
main();
