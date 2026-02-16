import fs from "fs";
import { afterEach, describe, expect, it } from "vitest";
import { createLogWriter, stripAnsi } from "./LogWriter";

const createdLogFiles: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdLogFiles.map(async (filePath) => {
      try {
        await fs.promises.unlink(filePath);
      } catch {
        // Ignore cleanup errors for non-existing files.
      }
    }),
  );
  createdLogFiles.length = 0;
});

describe("createLogWriter", () => {
  it("uses provided logFilePath when creating writer", async () => {
    const logFilePath = `/tmp/hot-updater-log-writer-${Date.now()}.log`;
    const writer = await createLogWriter({
      prefix: "ansi-strip-test",
      logFilePath,
    });

    if (!writer.logFilePath) {
      throw new Error("Expected log file path to be created.");
    }

    createdLogFiles.push(logFilePath);
    expect(writer.logFilePath).toBe(logFilePath);
    await writer.close();
  });

  it("strips ANSI color/style escape sequences", () => {
    const withAnsi =
      "\u001b[36;1mnote: \u001b[0mBuilding targets in dependency order\n" +
      "\u001b[36m[hermes-engine]\u001b[0m \u001b[1mRunning script\u001b[0m";
    const sanitized = stripAnsi(withAnsi);

    expect(sanitized).toContain("note: Building targets in dependency order");
    expect(sanitized).toContain("[hermes-engine] Running script");
    expect(sanitized).not.toContain("[36m");
    expect(sanitized).not.toContain("36;1m");
    expect(sanitized).not.toContain("0m");
  });
});
