import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { findMissingClientPlugins, importsClientPlugin } from "./clientPlugins";

const INSIGHTS = {
  module: "@hot-updater/react-native",
  name: "insights",
};

const tempDirs: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const project = async (files: Record<string, string>) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hot-updater-doctor-"));
  tempDirs.push(dir);
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), text);
  }
  return dir;
};

describe("importsClientPlugin", () => {
  it.each([
    'import { HotUpdater, insights } from "@hot-updater/react-native";',
    'import { insights } from "@hot-updater/react-native";',
    "import { other, insights as withInsights } from '@hot-updater/react-native'",
    'import * as clientPlugins from "@hot-updater/react-native";',
  ])("finds %s", (source) => {
    expect(importsClientPlugin(source, INSIGHTS)).toBe(true);
  });

  it.each([
    'import type { insights } from "@hot-updater/react-native";',
    'import { type insights } from "@hot-updater/react-native";',
    'import { insights } from "./insights";',
    'import { insightsLog } from "@hot-updater/react-native";',
  ])("does not count %s", (source) => {
    expect(importsClientPlugin(source, INSIGHTS)).toBe(false);
  });
});

describe("findMissingClientPlugins", () => {
  it("finds the client plugins no app source imports, past node_modules and native code", async () => {
    const withInsights = await project({
      "src/App.tsx": `import { HotUpdater } from "@hot-updater/react-native";\nimport { insights } from "${INSIGHTS.module}";\n\nexport default HotUpdater.wrap({ plugins: [insights()] })(App);\n`,
    });
    const without = await project({
      "src/App.tsx":
        'import { HotUpdater } from "@hot-updater/react-native";\n',
      "node_modules/lib/index.js": `import { insights } from "${INSIGHTS.module}";\n`,
      "ios/Pods/x.js": `import { insights } from "${INSIGHTS.module}";\n`,
    });

    await expect(
      findMissingClientPlugins({
        clientPlugins: [INSIGHTS],
        cwd: withInsights,
      }),
    ).resolves.toEqual([]);
    await expect(
      findMissingClientPlugins({ clientPlugins: [INSIGHTS], cwd: without }),
    ).resolves.toEqual([INSIGHTS]);
  });
});
