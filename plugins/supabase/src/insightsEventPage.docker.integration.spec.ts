import { spawnSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findOpenPort } from "../../../packages/test-utils/src/runtimeProcess";
import { createSupabaseInsightsEventPage } from "./insightsEventPage";
import {
  SUPABASE_V1_FUNCTION_NAMES,
  SUPABASE_V1_TABLE_NAMES,
} from "./supabaseInfrastructureNames";
import type { Database } from "./types";

const secret = "local-insights-test-secret-with-at-least-32-characters";
const token = (role: string) => {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ role, exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
};
const docker = (args: string[], input?: string) => {
  const result = spawnSync("docker", args, { input, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
};

const waitUntil = async (ready: () => boolean | Promise<boolean>) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await ready()) return;
    await setTimeout(250);
  }
  throw new Error("Local Insights RPC fixture did not become ready.");
};

describe("Supabase Insights scalar RPC with PostgREST max_rows=1", () => {
  const network = `hot-updater-insights-${randomUUID().slice(0, 8)}`;
  const database = `${network}-db`;
  const rest = `${network}-rest`;
  let origin: string;
  let service: SupabaseClient<Database>;
  const client = (role: string) =>
    createClient<Database>(origin, token(role), {
      auth: { persistSession: false },
      // This focused fixture runs PostgREST directly, without Supabase's gateway.
      global: {
        fetch: (input, init) =>
          fetch(
            String(input).replace(`${origin}/rest/v1/`, `${origin}/`),
            init,
          ),
      },
    });

  beforeAll(async () => {
    // Do not silently download images as part of this bounded regression test.
    docker([
      "image",
      "inspect",
      "postgres:15-alpine",
      "postgrest/postgrest:v14.6",
    ]);
    docker(["network", "create", network]);
    docker([
      "run",
      "--detach",
      "--rm",
      "--pull=never",
      "--name",
      database,
      "--network",
      network,
      "--tmpfs",
      "/var/lib/postgresql/data:rw,size=128m",
      "-e",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      "postgres:15-alpine",
    ]);
    await waitUntil(
      () =>
        spawnSync("docker", [
          "exec",
          database,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "postgres",
        ]).status === 0,
    );
    const migrationDirectory = "plugins/supabase/supabase/migrations";
    const migrations = await Promise.all(
      (await readdir(migrationDirectory))
        .filter((file) => file.endsWith(".sql"))
        .sort()
        .map((file) => readFile(`${migrationDirectory}/${file}`, "utf8")),
    );
    docker(
      [
        "exec",
        "-i",
        database,
        "psql",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      `
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE ROLE authenticator LOGIN NOINHERIT;
      GRANT anon, authenticated, service_role TO authenticator;
      ${migrations.join("\n")}
      INSERT INTO public.hot_updater_v1_bundle_events
        (id,type,install_id,from_bundle_id,to_bundle_id,platform,app_version,channel,cohort,update_strategy,received_at_ms)
      SELECT ('10000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid,
        'UPDATE_APPLIED', 'install-a', '00000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000001', 'ios','1.0.0','production','default','appVersion',100
      FROM generate_series(0,4) n;
    `,
    );
    const port = await findOpenPort();
    origin = `http://127.0.0.1:${port}`;
    docker([
      "run",
      "--detach",
      "--rm",
      "--pull=never",
      "--name",
      rest,
      "--network",
      network,
      "-p",
      `127.0.0.1:${port}:3000`,
      "-e",
      `PGRST_DB_URI=postgres://authenticator@${database}:5432/postgres`,
      "-e",
      "PGRST_DB_SCHEMAS=public",
      "-e",
      "PGRST_DB_ANON_ROLE=anon",
      "-e",
      "PGRST_DB_MAX_ROWS=1",
      "-e",
      `PGRST_JWT_SECRET=${secret}`,
      "postgrest/postgrest:v14.6",
    ]);
    await waitUntil(async () => {
      try {
        return (await fetch(origin)).ok;
      } catch {
        return false;
      }
    });
    service = client("service_role");
  }, 60_000);

  afterAll(() => {
    spawnSync("docker", ["rm", "--force", rest, database]);
    spawnSync("docker", ["network", "rm", network]);
  });

  it("truncates ordinary rows but returns the complete scalar page and continuation", async () => {
    const ordinary = await service
      .from(SUPABASE_V1_TABLE_NAMES.bundleEvents)
      .select("*")
      .limit(2);
    expect(ordinary.error).toBeNull();
    expect(ordinary.data).toHaveLength(1);

    const page = createSupabaseInsightsEventPage(service);
    const input = {
      scope: { kind: "all" },
      beforeReceivedAtMs: 101,
      limit: 2,
    } as const;
    const first = await page(input);
    expect(first.rows).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await page({ ...input, cursor: first.nextCursor! });
    expect(second.rows).toHaveLength(2);
    const third = await page({ ...input, cursor: second.nextCursor! });
    expect(third.rows).toHaveLength(1);
    expect(third.nextCursor).toBeNull();
    expect(
      new Set(
        [...first.rows, ...second.rows, ...third.rows].map((row) => row.id),
      ).size,
    ).toBe(5);
    for (const scope of [
      { kind: "installation", installId: "install-a" },
      { kind: "bundle", bundleId: "00000000-0000-0000-0000-000000000001" },
    ] as const) {
      expect((await page({ ...input, scope })).rows).toHaveLength(2);
    }
  });

  it("does not expose event pages to anon or authenticated JWT roles", async () => {
    for (const role of ["anon", "authenticated"]) {
      const result = await client(role).rpc(
        SUPABASE_V1_FUNCTION_NAMES.insightsEventPage,
        {
          p_scope: "all",
          p_scope_id: null,
          p_limit: 2,
          p_before_received_at_ms: 101,
          p_cursor_received_at_ms: null,
          p_cursor_id: null,
        },
      );
      expect(result.data).toBeNull();
      expect(result.error?.code).toBe("42501");
    }
  });
});
