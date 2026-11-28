import { dynamoDB } from "@hot-updater/aws";
import { cosmosDatabase } from "@hot-updater/azure";
import { d1Database } from "@hot-updater/cloudflare";
import { firebaseDatabase } from "@hot-updater/firebase";
import type { ConfiguredDatabase } from "@hot-updater/plugin-core";
import { supabaseDatabase } from "@hot-updater/supabase";
import { postgres } from "@hot-updater/vercel";
import { describe, expect, it } from "vitest";

import { INIT_PROVIDER_PACKAGES, type InitProvider } from "./initProviders";

const DATABASE_TARGET = Symbol.for("@hot-updater/database-target");

/**
 * Each provider's saved inputs, and its database as init's config template
 * builds it from those inputs: the target init replays against, and the one
 * the config's database reaches, must be the same string.
 */
const CASES: Record<
  InitProvider,
  {
    readonly env: Record<string, string>;
    readonly database: (env: Record<string, string>) => ConfiguredDatabase;
  }
> = {
  cloudflare: {
    env: { HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID: "0b5f-d1" },
    database: (env) =>
      d1Database({
        databaseId: env["HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID"]!,
        accountId: "account",
        cloudflareApiToken: "token",
      }),
  },
  supabase: {
    env: {
      HOT_UPDATER_SUPABASE_PROJECT_ID: "abcdefgh",
      HOT_UPDATER_SUPABASE_URL: "https://abcdefgh.supabase.co",
    },
    database: (env) =>
      supabaseDatabase({
        supabaseUrl: env["HOT_UPDATER_SUPABASE_URL"]!,
        supabaseServiceRoleKey: "service-role",
      }),
  },
  aws: {
    env: { HOT_UPDATER_DYNAMODB_TABLE_NAME: "hot-updater" },
    database: (env) =>
      dynamoDB({
        region: "us-east-1",
        credentials: { accessKeyId: "id", secretAccessKey: "secret" },
        tableName: env["HOT_UPDATER_DYNAMODB_TABLE_NAME"]!,
      }),
  },
  firebase: {
    env: { HOT_UPDATER_FIREBASE_PROJECT_ID: "hot-updater-app" },
    database: (env) =>
      firebaseDatabase({ projectId: env["HOT_UPDATER_FIREBASE_PROJECT_ID"]! }),
  },
  vercel: {
    env: {
      HOT_UPDATER_VERCEL_DATABASE_URL:
        "postgresql://user:secret@ep-1.us-east-1.aws.neon.tech/neondb?sslmode=require",
    },
    database: (env) =>
      postgres({ connectionString: env["HOT_UPDATER_VERCEL_DATABASE_URL"]! }),
  },
  azure: {
    env: {
      HOT_UPDATER_AZURE_COSMOS_ACCOUNT: "hot-updater-cosmos",
      HOT_UPDATER_AZURE_COSMOS_CONNECTION_STRING:
        "AccountEndpoint=https://hot-updater-cosmos.documents.azure.com:443/;AccountKey=a2V5;",
    },
    database: (env) =>
      cosmosDatabase({
        connectionString: env["HOT_UPDATER_AZURE_COSMOS_CONNECTION_STRING"]!,
      }),
  },
};

describe("each provider's saved database target", () => {
  it.each(Object.keys(CASES) as InitProvider[])(
    "is the target %s's database factory marks for the database init saved",
    async (provider) => {
      const { env, database } = CASES[provider];
      const configured = database(env);
      try {
        const saved = INIT_PROVIDER_PACKAGES[provider].target(
          (key) => env[key],
        );
        expect(saved).toEqual(expect.any(String));
        expect(Reflect.get(configured, DATABASE_TARGET)).toBe(saved);
        expect(configured.name).toBe(INIT_PROVIDER_PACKAGES[provider].database);
      } finally {
        await configured.dispose?.();
      }
    },
  );

  it("does not name a target without the saved inputs that name it", () => {
    for (const provider of Object.keys(CASES) as InitProvider[]) {
      expect(INIT_PROVIDER_PACKAGES[provider].target(() => undefined)).toBe(
        undefined,
      );
    }
  });
});
