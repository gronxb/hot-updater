import { secret } from "@hot-updater/cli-tools";
import { describe, expect, it } from "vitest";

import { getConfigScaffold } from "./configTemplate";
import { initProvider } from "./init/index";

const secretNames = (text: string) =>
  [
    ...new Set(
      [...text.matchAll(/secret\("([^"]+)"\)/gu)].map(([, name]) => name!),
    ),
  ].sort();

describe("Supabase config scaffold", () => {
  it("names the project and bucket init set up, and reads the service role key with secret()", () => {
    expect(
      getConfigScaffold("bare", {
        supabaseUrl: "https://abcd.supabase.co",
        bucketName: "bundles",
      }).text,
    ).toMatchInlineSnapshot(`
      "import { bare } from "@hot-updater/bare";
      import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";
      import { defineConfig, localSecrets, secret } from "hot-updater";
      import { apiKeys, insights, remoteConfig } from "hot-updater/plugins";
      import { existsSync } from "node:fs";

      if (existsSync(".env.hotupdater")) {
        process.loadEnvFile(".env.hotupdater");
      }

      export default defineConfig({
        build: bare({ enableHermes: true }),
        storage: supabaseStorage({
          supabaseUrl: "https://abcd.supabase.co",
          supabaseServiceRoleKey: secret("HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY"),
          bucketName: "bundles",
        }),
        database: supabaseDatabase({
          supabaseUrl: "https://abcd.supabase.co",
          supabaseServiceRoleKey: secret("HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY"),
        }),
        plugins: [apiKeys(), insights(), remoteConfig()],
        secrets: localSecrets(),
        updateStrategy: "appVersion", // or "fingerprint"
      });"
    `);
  });

  it("reads the same credentials init stores in a team store", () => {
    expect(
      secretNames(
        getConfigScaffold("bare", {
          supabaseUrl: "https://abcd.supabase.co",
          bucketName: "bundles",
        }).text,
      ),
    ).toEqual([...initProvider.secrets].sort());
  });

  it("reads every value from the environment for the agent scaffold", () => {
    expect(getConfigScaffold("bare").text).not.toContain("secret(");
  });

  it("names secrets secret() takes", () => {
    expect(() =>
      initProvider.secrets.map((name) => secret(name)),
    ).not.toThrow();
  });
});
