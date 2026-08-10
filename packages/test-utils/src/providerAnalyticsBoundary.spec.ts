import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertProviderAnalyticsBoundary,
  findProviderAnalyticsBoundaryViolations,
} from "./providerAnalyticsBoundary";

const temporaryDirectories: string[] = [];

const createProvider = async (): Promise<string> => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "provider-analytics-boundary-"),
  );
  temporaryDirectories.push(directory);
  await mkdir(path.join(directory, "src"));
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("provider Analytics boundary", () => {
  it("accepts a provider implemented only against component-data contracts", async () => {
    const provider = await createProvider();
    await writeFile(
      path.join(provider, "src", "database.ts"),
      `import { universalComponentDataAdapterCapability } from "@hot-updater/plugin-core";
export const capability = universalComponentDataAdapterCapability;\n`,
    );

    await expect(
      findProviderAnalyticsBoundaryViolations({ roots: [provider] }),
    ).resolves.toEqual([]);
  });

  it.each([
    {
      contents: `import { analytics } from "@hot-updater/analytics";\n`,
      rule: "Analytics package import",
    },
    {
      contents: `import { createProvider } from "./d1AnalyticsProvider";\n`,
      rule: "Analytics module import",
    },
    {
      contents: `const capability = "hot-updater.analytics.provider@1";\n`,
      rule: "Analytics capability",
    },
    {
      contents: `type AnalyticsProvider = { query(): void };\n`,
      rule: "Analytics contract identifier",
    },
    {
      contents: `const analyticsQueries = {};\n`,
      rule: "Analytics contract identifier",
    },
    {
      contents: `const marker = "schema.analytics";\n`,
      rule: "Analytics schema marker",
    },
    {
      contents: `const table = "bundle_events";\n`,
      rule: "Analytics physical table",
    },
    {
      contents: `const event = "UPDATE_APPLIED";\n`,
      rule: "Analytics event literal",
    },
  ])("reports $rule with a source location", async ({ contents, rule }) => {
    const provider = await createProvider();
    const file = path.join(provider, "src", "database.ts");
    await writeFile(file, contents);

    await expect(
      findProviderAnalyticsBoundaryViolations({ roots: [provider] }),
    ).resolves.toEqual([
      expect.objectContaining({
        column: expect.any(Number),
        file,
        line: 1,
        rule,
      }),
    ]);
  });

  it("reports an Analytics-specific production module path", async () => {
    const provider = await createProvider();
    const file = path.join(provider, "src", "d1AnalyticsProvider.ts");
    await writeFile(file, `export const provider = {};\n`);

    await expect(
      findProviderAnalyticsBoundaryViolations({ roots: [provider] }),
    ).resolves.toEqual([
      { column: 1, file, line: 1, rule: "Analytics module path" },
    ]);
  });

  it("reports an Analytics package dependency", async () => {
    const provider = await createProvider();
    const file = path.join(provider, "package.json");
    await writeFile(
      file,
      JSON.stringify({ dependencies: { "@hot-updater/analytics": "1.0.0" } }),
    );

    await expect(
      findProviderAnalyticsBoundaryViolations({ roots: [provider] }),
    ).resolves.toEqual([
      expect.objectContaining({ file, rule: "Analytics package import" }),
    ]);
  });

  it("ignores test fixtures unless the caller includes tests", async () => {
    const provider = await createProvider();
    await writeFile(
      path.join(provider, "src", "database.spec.ts"),
      `const preservedSetting = "schema.analytics";\n`,
    );

    await expect(
      findProviderAnalyticsBoundaryViolations({ roots: [provider] }),
    ).resolves.toEqual([]);
    await expect(
      findProviderAnalyticsBoundaryViolations({
        includeTests: true,
        roots: [provider],
      }),
    ).resolves.toEqual([
      expect.objectContaining({ rule: "Analytics schema marker" }),
    ]);
  });

  it("ignores generated runtime acceptance bundles without hiding production violations", async () => {
    const provider = await createProvider();
    const generatedDirectory = path.join(
      provider,
      "runtime-acceptance-generated",
    );
    const productionFile = path.join(provider, "src", "database.ts");
    await mkdir(generatedDirectory);
    await writeFile(
      path.join(generatedDirectory, "index.js"),
      `const generatedTable = "bundle_events";\n`,
    );
    await writeFile(productionFile, `const table = "bundle_events";\n`);

    await expect(
      findProviderAnalyticsBoundaryViolations({ roots: [provider] }),
    ).resolves.toEqual([
      expect.objectContaining({
        file: productionFile,
        rule: "Analytics physical table",
      }),
    ]);
  });

  it("throws a readable boundary report", async () => {
    const provider = await createProvider();
    const file = path.join(provider, "src", "database.ts");
    await writeFile(file, `const table = "bundle_events";\n`);

    await expect(
      assertProviderAnalyticsBoundary({ roots: [provider] }),
    ).rejects.toThrow(`${file}:1:16 Analytics physical table`);
  });
});
