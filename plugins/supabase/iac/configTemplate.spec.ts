import { secretEnv } from "@hot-updater/cli-tools";
import { describe, expect, it } from "vitest";

import { getConfigScaffold } from "./configTemplate";
import { initProvider } from "./init/index";

const secretEnvNames = (text: string) =>
  /secretEnv\(\[([^\]]*)\]\)/u
    .exec(text)?.[1]
    ?.match(/"[A-Z0-9_]+"/gu)
    ?.map((name) => JSON.parse(name) as string);

describe("Supabase config scaffold", () => {
  it("names the project and bucket init set up, and reads the service role key with secretEnv", () => {
    expect(
      getConfigScaffold("bare", {
        supabaseUrl: "https://abcd.supabase.co",
        bucketName: "bundles",
      }).text,
    ).toMatchInlineSnapshot(`
      "import { bare } from "@hot-updater/bare";
      import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";
      import { defineConfig, localSecrets, secretEnv } from "hot-updater";
      import { apiKeys, insights, remoteConfig } from "hot-updater/plugins";
      import { existsSync } from "node:fs";

      if (existsSync(".env.hotupdater")) {
        process.loadEnvFile(".env.hotupdater");
      }

      const deploySecrets = secretEnv([
        "HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY",
      ]);

      export default defineConfig({
        build: bare({ enableHermes: true }),
        storage: supabaseStorage({
          supabaseUrl: "https://abcd.supabase.co",
          supabaseServiceRoleKey: async () =>
            (await deploySecrets()).HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY,
          bucketName: "bundles",
        }),
        database: supabaseDatabase({
          supabaseUrl: "https://abcd.supabase.co",
          supabaseServiceRoleKey: async () =>
            (await deploySecrets()).HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY,
        }),
        plugins: [apiKeys(), insights(), remoteConfig()],
        secrets: localSecrets(),
        updateStrategy: "appVersion", // or "fingerprint"
      });"
    `);
  });

  it("reads the same credentials init stores in a team store", () => {
    expect(
      secretEnvNames(
        getConfigScaffold("bare", {
          supabaseUrl: "https://abcd.supabase.co",
          bucketName: "bundles",
        }).text,
      ),
    ).toEqual(initProvider.secrets);
  });

  it("reads every value from the environment for the agent scaffold", () => {
    expect(getConfigScaffold("bare").text).not.toContain("secretEnv");
  });

  it("names variables secretEnv takes", () => {
    expect(() => secretEnv(initProvider.secrets)).not.toThrow();
  });
});
