import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { log } from "./log";
import { createLogWriter } from "./LogWriter";
import { p } from "./prompts";
import { maskSecretValues, registerSecretValue } from "./secretMasking";

const captureOutput = () => {
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => {
    text += chunk.toString();
  });
  return { output, read: () => text };
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("registerSecretValue", () => {
  it("masks the value and each line of a multi-line value", () => {
    registerSecretValue(
      [
        "-----BEGIN PRIVATE KEY-----",
        "maskLineOneOfTheKey",
        "maskLineTwoOfTheKey",
        "-----END PRIVATE KEY-----",
      ].join("\n"),
    );

    expect(maskSecretValues("a maskLineTwoOfTheKey b")).toBe("a ******** b");
    expect(maskSecretValues("-----BEGIN PRIVATE KEY-----")).toBe(
      "-----BEGIN PRIVATE KEY-----",
    );
  });

  it("masks a short value only where it stands alone", () => {
    registerSecretValue("pw#1");
    registerSecretValue("a");

    expect(maskSecretValues("-Ppassword=pw#1 and a")).toBe(
      "-Ppassword=******** and ********",
    );
    expect(maskSecretValues("Gradle failed: pw#12")).toBe(
      "Gradle failed: pw#12",
    );
  });

  it("does not mask the short lines of a multi-line value", () => {
    registerSecretValue('{\n  "private_key": "maskJsonPrivateKey"\n}');

    expect(maskSecretValues("{ }")).toBe("{ }");
    expect(maskSecretValues('"private_key": "maskJsonPrivateKey"')).toBe(
      "********",
    );
  });
});

describe("log sinks", () => {
  const secret = "sink-secret-value-1";
  registerSecretValue(secret);

  it("masks p.log, p.note, and spinner messages", async () => {
    vi.stubEnv("CI", "true");
    const captured = captureOutput();

    p.log.info(`password ${secret}`, { output: captured.output });
    p.log.message([`line ${secret}`], { output: captured.output });
    p.note(`note ${secret}`, `title ${secret}`, { output: captured.output });
    const spinner = p.spinner({ output: captured.output });
    spinner.start(`start ${secret}`);
    spinner.stop(`stop ${secret}`);
    await p.tasks(
      [
        {
          title: `task ${secret}`,
          task: () => `done ${secret}`,
        },
      ],
      { output: captured.output },
    );

    expect(captured.read()).not.toContain(secret);
    expect(captured.read()).toContain("password ********");
    expect(captured.read()).toContain("stop ********");
  });

  it("masks log", () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    log.normal(`password ${secret}`);
    log.error(`password ${secret}`);

    expect(consoleLog.mock.calls.flat().join("\n")).not.toContain(secret);
    expect(consoleLog).toHaveBeenCalledWith("password ********");
  });

  it("masks build log files, even across chunks", async () => {
    const logFilePath = path.join(
      os.tmpdir(),
      `hot-updater-mask-${Date.now()}.log`,
    );
    const writer = await createLogWriter({ prefix: "mask", logFilePath });

    await writer.writeStream(
      Readable.from([
        `-Pkey.password=${secret.slice(0, 7)}`,
        `${secret.slice(7)}\n`,
      ]),
    );
    writer.writeError(new Error(`failed with ${secret}`));
    await writer.close();

    const written = await fs.readFile(logFilePath, "utf-8");
    await fs.rm(logFilePath, { force: true });
    expect(written).not.toContain(secret);
    expect(written).toContain("-Pkey.password=********");
  });
});
