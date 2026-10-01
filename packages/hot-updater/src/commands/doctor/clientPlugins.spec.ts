import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createMemoryAdapter } from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { insights } from "@hot-updater/server/plugins/insights";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadServer } from "../../utils/loadServer";
import {
  findMissingClientPlugins,
  importsClientPlugin,
  readServerClientPlugins,
} from "./clientPlugins";

vi.mock("../../utils/loadServer", () => ({ loadServer: vi.fn() }));

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

describe("readServerClientPlugins", () => {
  it("reads the client plugins of the server definition's plugins", async () => {
    const dispose = vi.fn(async () => {});
    vi.mocked(loadServer).mockResolvedValue({
      kind: "definition",
      definition: createHotUpdater({
        database: { name: "memory", adapter: createMemoryAdapter() },
        plugins: [insights()],
        clientAccess: "public",
      }),
      dispose,
    } as never);

    await expect(
      readServerClientPlugins({ server: "/project/hotUpdater.ts" }),
    ).resolves.toEqual([INSIGHTS]);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("reads the client plugins a self-hosted server lists on its admin /version", async () => {
    const fetchAdmin = vi.fn(async () =>
      Response.json({ plugins: ["insights"], clientPlugins: [INSIGHTS] }),
    );
    const dispose = vi.fn(async () => {});
    vi.mocked(loadServer).mockResolvedValue({
      kind: "remote",
      server: { fetchAdmin },
      dispose,
    } as never);

    await expect(
      readServerClientPlugins({ server: {} as never }),
    ).resolves.toEqual([INSIGHTS]);
    expect(fetchAdmin).toHaveBeenCalledWith("/version");
    expect(dispose).toHaveBeenCalledOnce();
  });
});
