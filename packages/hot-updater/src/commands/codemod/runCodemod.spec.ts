import fs from "fs/promises";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clientAccessCodemod as codemod } from "./clientAccess";
import { runCodemod } from "./runCodemod";

const { mockLog } = vi.hoisted(() => ({
  mockLog: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return { ...actual, p: { ...actual.p, log: mockLog } };
});

const RC_SERVER = `import { createHotUpdater } from "@hot-updater/server";

export const hotUpdater = createHotUpdater({
  database,
  clientAccess: { type: "public" },
});
`;

const MIGRATED_SERVER = `import { createHotUpdater } from "@hot-updater/server";
import { insights } from "@hot-updater/server/plugins/insights";

export const hotUpdater = createHotUpdater({
  database,
  clientAccess: "public",
  plugins: [insights()],
});
`;

const UNSAFE_SERVER = `import { createHotUpdater } from "@hot-updater/server";

export const hotUpdater = createHotUpdater({ database, clientAccess: access });
`;

let cwd: string;

const write = async (file: string, text: string) => {
  await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
  await fs.writeFile(path.join(cwd, file), text);
};

const read = (file: string) => fs.readFile(path.join(cwd, file), "utf-8");

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-codemod-"));
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process exit ${code}`);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await fs.rm(cwd, { recursive: true, force: true });
});

describe("runCodemod", () => {
  it("rewrites the source files under the current directory", async () => {
    // Given a server file, a migrated one, and a dependency with an old call
    await write("src/server.ts", RC_SERVER);
    await write("src/migrated.ts", MIGRATED_SERVER);
    await write("node_modules/some-package/index.ts", RC_SERVER);

    // When the codemod runs without paths
    await runCodemod(codemod, [], { cwd });

    // Then only the project's own old call is rewritten
    expect(await read("src/server.ts")).toBe(MIGRATED_SERVER);
    expect(await read("src/migrated.ts")).toBe(MIGRATED_SERVER);
    expect(await read("node_modules/some-package/index.ts")).toBe(RC_SERVER);
    expect(mockLog.success).toHaveBeenCalledWith(
      expect.stringContaining("src/server.ts"),
    );
  });

  it("prints the diff and writes nothing on a dry run", async () => {
    await write("src/server.ts", RC_SERVER);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCodemod(codemod, ["src"], { cwd, dryRun: true });

    expect(await read("src/server.ts")).toBe(RC_SERVER);
    const printed = output.mock.calls.map(([text]) => String(text)).join("\n");
    expect(printed).toContain("--- a/src/server.ts");
    expect(printed).toContain('-  clientAccess: { type: "public" },');
    expect(printed).toContain('+  clientAccess: "public",');
    expect(printed).toContain("+  plugins: [insights()],");
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.stringContaining("1 file would change"),
    );
  });

  it("reports a file it cannot rewrite, keeps it, and exits with 1", async () => {
    await write("src/server.ts", RC_SERVER);
    await write("src/unsafe.ts", UNSAFE_SERVER);

    await expect(
      runCodemod(codemod, ["src/server.ts", "src/*.ts"], { cwd }),
    ).rejects.toThrow("process exit 1");

    expect(await read("src/server.ts")).toBe(MIGRATED_SERVER);
    expect(await read("src/unsafe.ts")).toBe(UNSAFE_SERVER);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining("src/unsafe.ts:3:"),
    );
  });

  it("refuses a path that does not exist before changing anything", async () => {
    await write("src/server.ts", RC_SERVER);

    await expect(
      runCodemod(codemod, ["src/server.ts", "src/missing.ts"], { cwd }),
    ).rejects.toThrow("process exit 1");

    expect(await read("src/server.ts")).toBe(RC_SERVER);
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.stringContaining("src/missing.ts"),
    );
  });
});
