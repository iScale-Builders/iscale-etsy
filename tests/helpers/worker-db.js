import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

export const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
export const LANE_ID = "22222222-2222-4222-8222-222222222222";
export const AGENT_ID = "33333333-3333-4333-8333-333333333333";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../supabase/migrations");

export async function createWorkerDb() {
  const db = new PGlite();
  await db.exec(`
    create schema if not exists auth;
    create table if not exists auth.users (
      id uuid primary key,
      email text
    );
    create or replace function auth.uid() returns uuid
    language sql
    stable
    as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
  `);
  const files = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
  for (const name of files) {
    await db.exec(readFileSync(join(migrationsDir, name), "utf8"));
  }
  await db.exec(`
    insert into auth.users (id, email) values
      ('${ADMIN_ID}', 'admin@example.test'),
      ('${LANE_ID}', 'lane@example.test'),
      ('${AGENT_ID}', 'agent@example.test');
    insert into etsy_worker.operators (user_id, role, lane_name) values
      ('${ADMIN_ID}', 'admin', null),
      ('${LANE_ID}', 'lane', 'lane-1'),
      ('${AGENT_ID}', 'agent', null);
  `);
  await setUid(db, ADMIN_ID);
  return db;
}

export async function setUid(db, uid) {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [uid || ""]);
}
