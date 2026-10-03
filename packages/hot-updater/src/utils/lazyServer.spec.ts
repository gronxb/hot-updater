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
  // A database that refuses every call, and a plugin that refuses to start:
  // a command that reads the database or assembles the server fails.
  await fs.writeFile(
    path.join(project, "hot-updater.config.ts"),
    [
      "const refuse = () => {",
      '  throw new Error("The database was read.");',
      "};",
      "",
      "export default {",
      "  database: {",
      '    name: "refusing",',
      '    adapter: { id: "refusing", fits: refuse, get: refuse, query: refuse, write: refuse },',
      "  },",
      "  plugins: [",
      "    {",
      '      id: "refusing",',
      '      schemaVersion: "1",',
      "      schema: {},",
      "      init: () => {",
      '        throw new Error("The server was assembled.");',
      "      },",
      "    },",
      "  ],",
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

describe("commands that never assemble the server", () => {
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
