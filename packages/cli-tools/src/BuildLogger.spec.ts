import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BuildLogger } from "./BuildLogger";
import { registerSecretValue } from "./secretMasking";

vi.mock("./step", () => ({
  startStep: () => ({ update: vi.fn(), stop: vi.fn() }),
}));

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "build-logger-"));
  vi.spyOn(process, "cwd").mockReturnValue(directory);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { force: true, recursive: true });
});

describe("BuildLogger failure summary", () => {
  it("masks a registered value a cut line would split", async () => {
    const token = "ghp_buildLoggerSpecToken0123456789abcdef";
    registerSecretValue(token);
    const logger = new BuildLogger({
      logPrefix: "spec",
      createPhaseReader: () => () => undefined,
      failureSummary: { lines: ["error:"], blocks: [], maxWidth: 40 },
    });
    await logger.start({ title: "Building" });

    // The token starts before column 40 and ends after it.
    await logger.processStream(
      Readable.from([`error: clone https://${token}@example.com/pod.git\n`]),
    );

    const [line] = logger.failureSummary;
    expect(line).toBeDefined();
    expect(line).not.toContain("ghp_buildLogger");
  });
});
