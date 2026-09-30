import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureFingerprintConfig } from "./fingerprint/common";
import { getChannel, setChannel } from "./setChannel";

let project: string;

beforeEach(async () => {
  project = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-lazy-"));
  await fs.writeFile(
    path.join(project, "package.json"),
    JSON.stringify({ name: "app", private: true }),
  );
  // Loading the server definition fails, so a command that loads it fails.
  await fs.writeFile(
    path.join(project, "hotUpdater.ts"),
    'throw new Error("The server definition was loaded.");\n',
  );
  await fs.writeFile(
    path.join(project, "hot-updater.config.ts"),
    [
      "export default {",
      '  server: "./hotUpdater.ts",',
      '  updateStrategy: "fingerprint",',
      "  build: () => ({",
      '    name: "test",',
      "    build: async () => ({}),",
      "    nativeBuild: { getFingerprintExtraSources: async () => [] },",
      "  }),",
      "  platform: {",
      '    ios: { infoPlistPaths: ["ios/Info.plist"] },',
      "    android: { androidManifestPaths: [] },",
      "  },",
      "};",
      "",
    ].join("\n"),
  );
  await fs.mkdir(path.join(project, "ios"));
  await fs.writeFile(
    path.join(project, "ios/Info.plist"),
    '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict></dict></plist>\n',
  );
  vi.spyOn(process, "cwd").mockReturnValue(project);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(project, { recursive: true, force: true });
});

describe("commands that never load the server definition", () => {
  it("sets and reads the channel", async () => {
    await expect(setChannel("ios", "beta")).resolves.toMatchObject({
      paths: [expect.stringContaining("Info.plist")],
    });
    await expect(getChannel("ios")).resolves.toMatchObject({ value: "beta" });
  });

  it("reads the fingerprint settings", async () => {
    await expect(ensureFingerprintConfig()).resolves.toBeTypeOf("object");
  });
});
