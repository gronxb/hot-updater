import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  HotUpdaterConfigScaffold,
  InitProviderDefinition,
} from "@hot-updater/cli-tools";
import { describe, expect, it } from "vitest";

import { importPublished } from "./published.ts";

const { readServerDefinitionStatus } = await importPublished<
  typeof import("@hot-updater/cli-tools")
>("@hot-updater/cli-tools");

/** The server definitions a provider's init writes, from its published init entry. */
const definitionsOf = async (provider: string) =>
  (
    await importPublished<{ readonly initProvider: InitProviderDefinition }>(
      `@hot-updater/${provider}/init`,
    )
  ).initProvider.serverDefinitions?.() ?? [];

/**
 * How the definition at `file` compares with those `provider`'s init
 * writes: `unchanged` when it is one of them, `edited` otherwise.
 */
const statusOf = async (provider: string, file: string) => {
  for (const text of await definitionsOf(provider)) {
    const scaffold = { definition: { text } } as HotUpdaterConfigScaffold;
    if ((await readServerDefinitionStatus(scaffold, file)) === "unchanged") {
      return "unchanged";
    }
  }
  return "edited";
};

const exampleDir = path.resolve(import.meta.dirname, "../../examples/v0.85.0");

/** The example's own plugin, which every managed server here runs beside the provider's. */
const SAMPLE_IMPORT = '\nimport { sample } from "./samplePlugin";\n';
const SAMPLE_PLUGINS = "\n  plugins: [...plugins, sample()],\n";

describe("example app managed servers", () => {
  // The aws profile signs in through AWS SSO; init writes a definition
  // for each sign-in mode.
  it.each(["cloudflare", "supabase", "firebase", "aws"])(
    "defines the %s profile's server as init does, plus the example's own plugin, so a redeploy bundles it and the controller reads Insights in process",
    async (provider) => {
      const file = path.join(exampleDir, "servers", `${provider}.ts`);
      const text = await readFile(file, "utf8");
      expect(text).toContain(SAMPLE_IMPORT);
      expect(text).toContain(SAMPLE_PLUGINS);
      // An edited definition, which init bundles into the managed server.
      await expect(statusOf(provider, file)).resolves.toBe("edited");

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
        await expect(statusOf(provider, initWrites)).resolves.toBe(
          "unchanged",
        );
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
