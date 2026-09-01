import { spawnSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

import type {
  InsightsInstallationPageInput,
  InsightsPageEventsInput,
  InsightsReportPageInput,
} from "@hot-updater/plugin-core";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll } from "vitest";

import {
  registerRequiredInsightsModelTests,
  type RequiredInsightsModelConformanceHarness,
} from "../../../packages/test-utils/src/requiredInsightsModelConformance";
import { findOpenPort } from "../../../packages/test-utils/src/runtimeProcess";
import {
  createSupabaseInsights,
  createSupabaseInsightsMaintenance,
} from "./supabaseInsights";
import type { Database } from "./types";

const secret = "local-supabase-conformance-secret-with-32-characters";
const network = `hot-updater-supabase-conformance-${randomUUID().slice(0, 8)}`;
const postgres = `${network}-db`;
const primaryRest = `${network}-primary`;
const otherRest = `${network}-other`;
const primaryDatabase = "insights_primary";
const otherDatabase = "insights_other";
let primaryOrigin = "";
let otherOrigin = "";
let migrations = "";

const docker = (args: string[], input?: string) => {
  const result = spawnSync("docker", args, { input, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
};

const psql = (database: string, sql: string, variables: string[] = []) =>
  docker(
    [
      "exec",
      "-i",
      postgres,
      "psql",
      "-h",
      "127.0.0.1",
      "-U",
      "postgres",
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      ...variables.flatMap((variable) => ["-v", variable]),
    ],
    sql,
  );

const token = () => {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      role: "service_role",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
};

const waitUntil = async (ready: () => boolean | Promise<boolean>) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await ready()) return;
    await setTimeout(250);
  }
  throw new Error("Supabase conformance fixture did not become ready.");
};

const client = (origin: string): SupabaseClient<Database> =>
  createClient<Database>(origin, token(), {
    auth: { persistSession: false },
    global: {
      fetch: (input, init) =>
        fetch(String(input).replace(`${origin}/rest/v1/`, `${origin}/`), init),
    },
  });

beforeAll(async () => {
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
    postgres,
    "--network",
    network,
    "--tmpfs",
    "/var/lib/postgresql/data:rw,size=512m",
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "postgres:15-alpine",
  ]);
  await waitUntil(
    () =>
      spawnSync("docker", [
        "exec",
        postgres,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
      ]).status === 0,
  );
  psql(
    "postgres",
    `CREATE ROLE anon NOLOGIN;
     CREATE ROLE authenticated NOLOGIN;
     CREATE ROLE service_role NOLOGIN BYPASSRLS;
     CREATE ROLE authenticator LOGIN NOINHERIT;
     GRANT anon, authenticated, service_role TO authenticator;
     CREATE DATABASE ${primaryDatabase};
     CREATE DATABASE ${otherDatabase};`,
  );
  migrations = (
    await Promise.all(
      (
        await readdir("plugins/supabase/supabase/migrations")
      )
        .filter((file) => file.endsWith(".sql"))
        .sort()
        .map((file) =>
          readFile(`plugins/supabase/supabase/migrations/${file}`, "utf8"),
        ),
    )
  ).join("\n");
  const primaryPort = await findOpenPort();
  const otherPort = await findOpenPort();
  primaryOrigin = `http://127.0.0.1:${primaryPort}`;
  otherOrigin = `http://127.0.0.1:${otherPort}`;
  for (const [name, database, port] of [
    [primaryRest, primaryDatabase, primaryPort],
    [otherRest, otherDatabase, otherPort],
  ] as const) {
    docker([
      "run",
      "--detach",
      "--rm",
      "--pull=never",
      "--name",
      name,
      "--network",
      network,
      "-p",
      `127.0.0.1:${port}:3000`,
      "-e",
      `PGRST_DB_URI=postgres://authenticator@${postgres}:5432/${database}`,
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
  }
  await waitUntil(async () => {
    try {
      return (await fetch(primaryOrigin)).ok && (await fetch(otherOrigin)).ok;
    } catch {
      return false;
    }
  });
}, 60_000);

afterAll(() => {
  spawnSync("docker", ["rm", "--force", primaryRest, otherRest, postgres]);
  spawnSync("docker", ["network", "rm", network]);
});

const resetDatabase = (database: string) =>
  psql(
    database,
    `DROP SCHEMA public CASCADE;
     CREATE SCHEMA public;
     GRANT ALL ON SCHEMA public TO postgres;
     GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
     ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
       GRANT ALL ON TABLES TO anon, authenticated, service_role;
     ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
       GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
     ${migrations}
     NOTIFY pgrst, 'reload schema';`,
  );

type RpcClient = Pick<SupabaseClient<Database>, "rpc">;

const observedClient = (
  client: SupabaseClient<Database>,
  reads: { value: number },
): RpcClient => ({
  rpc: (async (...input: unknown[]) => {
    reads.value = 0;
    const result = (await Reflect.apply(client.rpc, client, input)) as {
      readonly data: unknown;
    };
    if (typeof result.data === "object" && result.data !== null) {
      const candidateReads = Reflect.get(result.data, "candidateReads");
      if (Number.isSafeInteger(candidateReads) && candidateReads >= 0) {
        reads.value = candidateReads;
      }
    }
    return result;
  }) as unknown as RpcClient["rpc"],
});

const createHarness =
  async (): Promise<RequiredInsightsModelConformanceHarness> => {
    resetDatabase(primaryDatabase);
    resetDatabase(otherDatabase);
    docker(["restart", primaryRest, otherRest]);
    await waitUntil(async () => {
      try {
        return (await fetch(primaryOrigin)).ok && (await fetch(otherOrigin)).ok;
      } catch {
        return false;
      }
    });
    const clock = { value: Date.now() };
    const primaryReads = { value: 0 };
    const otherReads = { value: 0 };
    const complete = new Set<string>();

    const facades = () => {
      const primaryClient = client(primaryOrigin);
      const otherClient = client(otherOrigin);
      const primaryModel = createSupabaseInsights(
        observedClient(primaryClient, primaryReads),
        primaryOrigin,
        () => clock.value,
      );
      const otherModel = createSupabaseInsights(
        observedClient(otherClient, otherReads),
        otherOrigin,
        () => clock.value,
      );
      const primaryMaintenance =
        createSupabaseInsightsMaintenance(primaryClient);
      const otherMaintenance = createSupabaseInsightsMaintenance(otherClient);
      const harness: RequiredInsightsModelConformanceHarness = {
        model: primaryModel,
        otherNamespaceModel: otherModel,
        async runJobStep(jobId, input) {
          const result = await primaryMaintenance.runJobStep(jobId, input);
          if (result.state === "complete") complete.add(jobId);
          return result;
        },
        async runOtherNamespaceJobStep(jobId, input) {
          const result = await otherMaintenance.runJobStep(jobId, input);
          if (result.state === "complete") complete.add(jobId);
          return result;
        },
        reopen: facades,
        insertMigrationPoisonRow() {
          psql(
            primaryDatabase,
            `WITH source AS (
             SELECT committed_seq + 1 AS seq
             FROM public.hot_updater_v1_insights_source_state WHERE id=1
           ), inserted AS (
             INSERT INTO public.hot_updater_v1_bundle_events (
               id,type,install_id,to_bundle_id,platform,app_version,channel,
               cohort,received_at_ms,insights_event,insights_source_seq,
               insights_install_key,insights_cohort_order
             ) SELECT
               '00000000-0000-7000-8000-00000000dead','UNCHANGED','poison',
               '10000000-0000-7000-8000-000000000001','ios','1.0.0',
               'production','poison',999,
               '{"id":"00000000-0000-7000-8000-00000000dead","type":"UNCHANGED","install_id":"poison","user_id":null,"username":null,"from_bundle_id":null,"from_release_id":null,"to_bundle_id":"10000000-0000-7000-8000-000000000001","to_release_id":null,"platform":"ios","app_version":"1.0.0","channel":"production","cohort":"poison","update_strategy":null,"fingerprint_hash":null,"sdk_version":null,"received_at_ms":999}'::jsonb,
               source.seq,NULL,decode('0070006f00690073006f006e','hex')
             FROM source RETURNING insights_source_seq
           ) UPDATE public.hot_updater_v1_insights_source_state
             SET committed_seq=(SELECT insights_source_seq FROM inserted)
             WHERE id=1;`,
          );
        },
        setCurrentTimeMs(nowMs) {
          clock.value = nowMs;
        },
        async expirePublication(publicationId) {
          const retentionJob = "supabase-v2-retention:9007199254740991";
          for (let step = 0; step < 256; step += 1) {
            const result = await primaryMaintenance.runJobStep(retentionJob, {
              maxItems: 4096,
              maxRequests: 1,
            });
            if (result.state === "complete") {
              complete.delete(publicationId);
              return;
            }
            if (result.state === "failed") break;
          }
          throw new Error("Supabase Insights retention did not complete");
        },
        publicationStateForJob(jobId) {
          return complete.has(jobId) ? "complete" : "absent";
        },
        getLastStorageReadCount(namespace = "primary") {
          return namespace === "primary"
            ? primaryReads.value
            : otherReads.value;
        },
        getPageEventsCandidateReadBudget(input: InsightsPageEventsInput) {
          return input.selector.kind === "all"
            ? input.limit + 1
            : 2 * (input.limit + 1);
        },
        getPageInstallationsCandidateReadBudget(
          input: InsightsInstallationPageInput,
        ) {
          return input.limit + 1;
        },
        getPageReportCandidateReadBudget(input: InsightsReportPageInput) {
          return input.limit + 1;
        },
      };
      return harness;
    };
    return facades();
  };

registerRequiredInsightsModelTests(createHarness);
