import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ASC_CLI_VERSION, AscCliUnavailableError, findAscCli } from "./ascCli";

// From https://github.com/rorkai/App-Store-Connect-CLI/releases/download/5.16.1/asc_5.16.1_checksums.txt
const RELEASE_ARM64_SHA256 =
  "85a848ef33fe3490adc4f0348af30b7bbf95209a258dac06c735318f62495707";

let dir: string;

const fakeOnPath = async (version: string) => {
  const command = path.join(dir, `asc-${version}`);
  await fs.writeFile(
    command,
    `#!${process.execPath}\nprocess.stdout.write("${version} (commit: abc, date: 2026-10-24)\\n");\n`,
    { mode: 0o755 },
  );
  return command;
};

const binaryResponse = (bytes: Buffer) =>
  new Response(new Uint8Array(bytes), { status: 200 });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "asc-cli-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("findAscCli", () => {
  it("is macOS only", async () => {
    await expect(findAscCli({ platform: "linux" })).rejects.toThrow(
      AscCliUnavailableError,
    );
  });

  it.each([ASC_CLI_VERSION, "5.17.0", "6.0.0"])(
    "uses the asc on PATH at %s",
    async (version) => {
      const fetch = vi.fn();
      const pathCommand = await fakeOnPath(version);
      await expect(
        findAscCli({ pathCommand, cacheDir: dir, fetch, platform: "darwin" }),
      ).resolves.toEqual({ path: pathCommand, version, source: "path" });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("downloads the pinned release instead of an older asc on PATH, and refuses one whose checksum differs", async () => {
    const fetch = vi.fn(async () => binaryResponse(Buffer.from("tampered")));
    const error = await findAscCli({
      pathCommand: await fakeOnPath("5.15.0"),
      cacheDir: dir,
      fetch,
      platform: "darwin",
      arch: "arm64",
    }).catch((caught: unknown) => caught);

    expect(fetch).toHaveBeenCalledWith(
      `https://github.com/rorkai/App-Store-Connect-CLI/releases/download/${ASC_CLI_VERSION}/asc_${ASC_CLI_VERSION}_macOS_arm64`,
      { redirect: "follow" },
    );
    expect(error).toBeInstanceOf(AscCliUnavailableError);
    expect((error as Error).message).toContain(
      `failed its SHA-256 check; it was deleted.\nExpected ${RELEASE_ARM64_SHA256}\nGot      ${crypto.createHash("sha256").update("tampered").digest("hex")}`,
    );
    expect((error as Error).message).toContain("brew install asc");
    // Neither the binary nor a partial download is left to run.
    const versionDir = path.join(dir, "asc", ASC_CLI_VERSION);
    expect(await fs.readdir(versionDir)).toEqual([]);
  });

  it("says how to install asc when GitHub is not reached", async () => {
    const error = await findAscCli({
      pathCommand: path.join(dir, "missing-asc"),
      cacheDir: dir,
      fetch: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
      platform: "darwin",
      arch: "x64",
    }).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe(
      `Couldn't download asc ${ASC_CLI_VERSION} from GitHub.\nfetch failed\nInstall asc ${ASC_CLI_VERSION} or later with brew install asc, then run this again.`,
    );
  });

  it("keeps a download whose checksum matches, executable, and reuses it", async () => {
    const bytes = Buffer.from("the asc release binary");
    // Stands in for the release binary's digest: only the pinned SHA-256 is
    // trusted, and the real binary is 58 MB.
    const realCreateHash = crypto.createHash;
    vi.spyOn(crypto, "createHash").mockImplementation(((algorithm: string) => {
      const hash = realCreateHash(algorithm);
      const chunks: Buffer[] = [];
      return {
        update(chunk: Buffer) {
          chunks.push(Buffer.from(chunk));
          return this;
        },
        digest(encoding: crypto.BinaryToTextEncoding) {
          const whole = Buffer.concat(chunks);
          return whole.equals(bytes)
            ? RELEASE_ARM64_SHA256
            : hash.update(whole).digest(encoding);
        },
      };
    }) as unknown as typeof crypto.createHash);

    const fetch = vi.fn(async () => binaryResponse(bytes));
    const options = {
      pathCommand: path.join(dir, "missing-asc"),
      cacheDir: dir,
      fetch,
      platform: "darwin" as const,
      arch: "arm64",
    };
    const downloaded = await findAscCli(options);
    const binary = path.join(
      dir,
      "asc",
      ASC_CLI_VERSION,
      `asc_${ASC_CLI_VERSION}_macOS_arm64`,
    );
    expect(downloaded).toEqual({
      path: binary,
      version: ASC_CLI_VERSION,
      source: "download",
    });
    expect((await fs.stat(binary)).mode & 0o777).toBe(0o755);
    expect(await fs.readFile(binary)).toEqual(bytes);

    await expect(findAscCli(options)).resolves.toMatchObject({
      source: "cache",
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    // A cached binary that changed is downloaded again, not run.
    await fs.writeFile(binary, "changed");
    await expect(findAscCli(options)).resolves.toMatchObject({
      source: "download",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(existsSync(binary)).toBe(true);
  });
});
