import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCli } from "./cli.mjs";
import { findNativeBuild } from "./nativeBuild.mjs";

const DOWNLOAD_URL = "https://storage.example.com/app.apk?sig=secret";

describe("createCli", () => {
  let directory: string;
  let write: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "actions-cli-"));
    // A CLI that prints what `native-build find --json` does.
    await fs.writeFile(
      path.join(directory, "cli.cjs"),
      `console.log(JSON.stringify({ nativeBuild: { id: "build-1" }, downloadUrl: ${JSON.stringify(DOWNLOAD_URL)} }));`,
    );
    write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const cli = () =>
    createCli({
      env: process.env,
      actionEnv: {
        GITHUB_WORKSPACE: directory,
        INPUT_CLI: `${process.execPath} cli.cjs`,
      },
    });

  it("echoes captured output to the job's log", async () => {
    const { stdout } = await cli()(["native-build"], { capture: true });

    expect(stdout).toContain(DOWNLOAD_URL);
    expect(write.mock.calls.join("")).toContain(DOWNLOAD_URL);
  });

  it("returns a quiet command's output without echoing it", async () => {
    const { stdout } = await cli()(["native-build"], {
      capture: true,
      quiet: true,
    });

    expect(stdout).toContain(DOWNLOAD_URL);
    expect(write.mock.calls.join("")).not.toContain(DOWNLOAD_URL);
  });

  it("prints why a quiet command failed, which the CLI says on stdout", async () => {
    await fs.writeFile(
      path.join(directory, "cli.cjs"),
      `console.log("scheme release is not in nativeBuild.android"); process.exit(1);`,
    );

    const { code } = await cli()(["native-build"], {
      capture: true,
      quiet: true,
    });

    expect(code).toBe(1);
    expect(write.mock.calls.join("")).toContain(
      "scheme release is not in nativeBuild.android",
    );
  });

  it("keeps the download URL of native-build find out of the job's log", async () => {
    const found = await findNativeBuild(
      { cli: cli() },
      { platform: "android", scheme: "release", channel: "pr-12" },
    );

    expect(found.downloadUrl).toBe(DOWNLOAD_URL);
    expect(write.mock.calls.join("")).not.toContain(DOWNLOAD_URL);
  });
});
