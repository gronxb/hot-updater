import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readServerDefinitionStatus } from "../../packages/cli-tools/src/hotUpdaterConfig";
import { getConfigScaffold as aws } from "../../plugins/aws/iac/templates";
import { getConfigScaffold as cloudflare } from "../../plugins/cloudflare/iac/configTemplate";
import { getConfigScaffold as firebase } from "../../plugins/firebase/iac/configTemplate";
import { getConfigScaffold as supabase } from "../../plugins/supabase/iac/configTemplate";

const exampleDir = path.resolve(import.meta.dirname, "../../examples/v0.85.0");

describe("example app managed servers", () => {
  it.each([
    ["cloudflare", cloudflare("bare")],
    ["supabase", supabase("bare")],
    ["firebase", firebase("bare")],
    // The aws profile signs in through AWS SSO.
    ["aws", aws("bare", { mode: "sso", profile: "hot-updater" })],
  ])(
    "defines the %s profile's server as init does, so init redeploys it and the controller reads Insights in process",
    async (provider, scaffold) => {
      const file = path.join(exampleDir, "servers", `${provider}.ts`);

      await expect(readServerDefinitionStatus(scaffold, file)).resolves.toBe(
        "unchanged",
      );
      expect(await readFile(file, "utf8")).toMatch(/\n {2}plugins,\n/u);
    },
  );

  it("points the committed config at the Cloudflare profile's server", async () => {
    await expect(
      readFile(path.join(exampleDir, "hot-updater.config.ts"), "utf8"),
    ).resolves.toContain('server: "./servers/cloudflare.ts",');
  });
});
