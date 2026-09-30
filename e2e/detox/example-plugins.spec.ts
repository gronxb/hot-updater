import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readServerDefinitionStatus } from "../../packages/cli-tools/src/hotUpdaterConfig";
import { getConfigScaffold as aws } from "../../plugins/aws/iac/templates";
import { getConfigScaffold as cloudflare } from "../../plugins/cloudflare/iac/configTemplate";
import { getConfigScaffold as firebase } from "../../plugins/firebase/iac/configTemplate";
import { getConfigScaffold as supabase } from "../../plugins/supabase/iac/configTemplate";

const exampleDir = path.resolve(import.meta.dirname, "../../examples/v0.85.0");

/** The example's own plugin, which every managed server here runs beside the provider's. */
const SAMPLE_IMPORT = '\nimport { sample } from "./samplePlugin";\n';
const SAMPLE_PLUGINS = "\n  plugins: [...plugins, sample()],\n";

describe("example app managed servers", () => {
  it.each([
    ["cloudflare", cloudflare("bare")],
    ["supabase", supabase("bare")],
    ["firebase", firebase("bare")],
    // The aws profile signs in through AWS SSO.
    ["aws", aws("bare", { mode: "sso", profile: "hot-updater" })],
  ])(
    "defines the %s profile's server as init does, plus the example's own plugin, so a redeploy bundles it and the controller reads Insights in process",
    async (provider, scaffold) => {
      const file = path.join(exampleDir, "servers", `${provider}.ts`);
      const text = await readFile(file, "utf8");
      expect(text).toContain(SAMPLE_IMPORT);
      expect(text).toContain(SAMPLE_PLUGINS);
      // An edited definition, which init bundles into the managed server.
      await expect(readServerDefinitionStatus(scaffold, file)).resolves.toBe(
        "edited",
      );

      // Without the sample plugin, it is the definition init writes.
      const dir = await mkdtemp(path.join(os.tmpdir(), "example-server-"));
      try {
        const initWrites = path.join(dir, `${provider}.ts`);
        await writeFile(
          initWrites,
          text
            .replace(SAMPLE_IMPORT, "")
            .replace(SAMPLE_PLUGINS, "\n  plugins,\n"),
        );
        await expect(
          readServerDefinitionStatus(scaffold, initWrites),
        ).resolves.toBe("unchanged");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it("points the committed config at the Cloudflare profile's server", async () => {
    await expect(
      readFile(path.join(exampleDir, "hot-updater.config.ts"), "utf8"),
    ).resolves.toContain('server: "./servers/cloudflare.ts",');
  });
});
