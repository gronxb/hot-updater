import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";

import { afterEach, describe, expect, it } from "vitest";

import { writeLynxBackgroundEntry } from "./background-entry.ts";
import {
  packageLynxEmbeddedDirectory,
  LYNX_E2E_SDK3_FILES,
} from "./embedded-bundle.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("Lynx standalone background fixture", () => {
  it("returns a standalone init object and emits the build identity without injected globals", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lynx-background-"));
    roots.push(root);
    const identity = {
      bundleId: "00000000-0000-7000-8000-000000000002",
      marker: '\"}); throw new Error("injected"); //\n\\',
    };
    const entry = await writeLynxBackgroundEntry(root, identity);
    const script = runInNewContext(
      await fs.readFile(path.join(root, entry), "utf8"),
      {},
      { timeout: 1000 },
    );
    const values: string[] = [];
    script.init({
      tt: {
        NativeModules: {
          HotUpdaterBackground: {
            complete: (value: string) => values.push(value),
          },
        },
      },
    });
    expect(values).toHaveLength(1);
    expect(JSON.parse(values[0]!)).toEqual(identity);
  });

  it("includes the declared task and its exact bytes in the embedded artifact digest", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lynx-background-"));
    roots.push(root);
    for (const file of LYNX_E2E_SDK3_FILES) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), "fixture bytes");
    }
    const bundleId = "00000000-0000-7000-8000-000000000002";
    const backgroundEntry = await writeLynxBackgroundEntry(root, {
      bundleId,
      marker: "headless-staged-detox",
    });
    await packageLynxEmbeddedDirectory({
      root,
      platform: "android",
      bundleId,
      runtimeId: "test-runtime",
      backgroundEntry,
    });
    const metadata = JSON.parse(
      await fs.readFile(path.join(root, "hot-updater-lynx.json"), "utf8"),
    );
    const manifest = JSON.parse(
      await fs.readFile(path.join(root, "manifest.json"), "utf8"),
    );
    expect(metadata.backgroundEntry).toBe(backgroundEntry);
    for (const file of [backgroundEntry, "hot-updater-lynx.json"]) {
      expect(manifest.assets[file].fileHash).toBe(
        createHash("sha256")
          .update(await fs.readFile(path.join(root, file)))
          .digest("hex"),
      );
    }
  });
});
