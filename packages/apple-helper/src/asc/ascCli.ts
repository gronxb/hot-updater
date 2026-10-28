import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";

/**
 * The release of asc, the open-source App Store Connect CLI
 * (https://github.com/rorkai/App-Store-Connect-CLI, MIT), that signs in with
 * an Apple Account and issues App Store Connect API keys for Hot Updater. An
 * `asc` on PATH is used when it is at least this version.
 */
export const ASC_CLI_VERSION = "5.16.1";

/**
 * The SHA-256 of each macOS binary of the release, from its
 * asc_5.16.1_checksums.txt. Pinned here, so a download is trusted only when
 * it is the exact binary this version of Hot Updater was written against.
 */
const ASC_CLI_SHA256: Readonly<Record<string, string>> = {
  arm64: "85a848ef33fe3490adc4f0348af30b7bbf95209a258dac06c735318f62495707",
  x64: "5a978732e0c2f2b673da601568c489dfaa232ae32c93dcfa63b95f0b892a2580",
};

const ASC_RELEASE_ASSET: Readonly<Record<string, string>> = {
  arm64: `asc_${ASC_CLI_VERSION}_macOS_arm64`,
  x64: `asc_${ASC_CLI_VERSION}_macOS_amd64`,
};

const ASC_RELEASE_URL = `https://github.com/rorkai/App-Store-Connect-CLI/releases/download/${ASC_CLI_VERSION}`;

const INSTALL_HINT = `Install asc ${ASC_CLI_VERSION} or later with brew install asc, then run this again.`;

/** asc could not be found, downloaded, or verified. */
export class AscCliUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AscCliUnavailableError";
  }
}

const parseVersion = (output: string): readonly number[] | undefined => {
  const match = /(\d+)\.(\d+)\.(\d+)/u.exec(output);
  return match ? match.slice(1, 4).map(Number) : undefined;
};

const isAtLeast = (version: readonly number[], minimum: readonly number[]) => {
  for (let index = 0; index < minimum.length; index++) {
    const part = version[index] ?? 0;
    if (part !== minimum[index]) return part > minimum[index]!;
  }
  return true;
};

const sha256Of = (file: string) =>
  new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });

/** Where a downloaded asc is kept, per user, so every project shares it. */
export const defaultAscCacheDir = () =>
  path.join(os.homedir(), "Library", "Caches", "hot-updater");

/** The asc binary Hot Updater runs, and where it came from. */
export interface AscCli {
  readonly path: string;
  readonly version: string;
  readonly source: "path" | "cache" | "download";
}

/**
 * Finds asc: the `asc` on PATH when it is at least `ASC_CLI_VERSION`, else
 * the pinned release in `cacheDir`, downloaded from GitHub on first use and
 * verified against its pinned SHA-256 each time it is used. Only macOS has
 * one: TestFlight builds need Xcode.
 */
export const findAscCli = async ({
  cacheDir = defaultAscCacheDir(),
  fetch = globalThis.fetch,
  platform = process.platform,
  arch = process.arch,
  pathCommand = "asc",
}: {
  cacheDir?: string;
  fetch?: typeof globalThis.fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  /** The command looked up on PATH. */
  pathCommand?: string;
} = {}): Promise<AscCli> => {
  if (platform !== "darwin") {
    throw new AscCliUnavailableError(
      "Signing in to issue an App Store Connect API key needs macOS.",
    );
  }
  const minimum = parseVersion(ASC_CLI_VERSION)!;
  const onPath = await execa(pathCommand, ["--version"], {
    reject: false,
    env: { ASC_TELEMETRY_DISABLED: "1" },
    timeout: 15_000,
  }).catch(() => undefined);
  const pathVersion =
    onPath?.exitCode === 0 ? parseVersion(onPath.stdout) : undefined;
  if (pathVersion && isAtLeast(pathVersion, minimum)) {
    return {
      path: pathCommand,
      version: pathVersion.join("."),
      source: "path",
    };
  }

  const asset = ASC_RELEASE_ASSET[arch];
  const expected = ASC_CLI_SHA256[arch];
  if (!asset || !expected) {
    throw new AscCliUnavailableError(
      `asc publishes no macOS binary for ${arch}.\n${INSTALL_HINT}`,
    );
  }
  const binary = path.join(cacheDir, "asc", ASC_CLI_VERSION, asset);
  const cached = await sha256Of(binary).catch(() => undefined);
  if (cached === expected) {
    return { path: binary, version: ASC_CLI_VERSION, source: "cache" };
  }

  await fs.mkdir(path.dirname(binary), { recursive: true });
  // Written beside the binary and renamed, so a failed download never
  // leaves a partial binary in its place.
  const partial = `${binary}.${process.pid}.download`;
  try {
    let response: Response;
    try {
      response = await fetch(`${ASC_RELEASE_URL}/${asset}`, {
        redirect: "follow",
      });
    } catch (error) {
      throw new AscCliUnavailableError(
        `Couldn't download asc ${ASC_CLI_VERSION} from GitHub.\n${error instanceof Error ? error.message : String(error)}\n${INSTALL_HINT}`,
        { cause: error },
      );
    }
    if (!response.ok || !response.body) {
      throw new AscCliUnavailableError(
        `Couldn't download asc ${ASC_CLI_VERSION} from GitHub (HTTP ${response.status}).\n${INSTALL_HINT}`,
      );
    }
    await fs.writeFile(partial, Buffer.from(await response.arrayBuffer()), {
      mode: 0o700,
    });
    const actual = await sha256Of(partial);
    if (actual !== expected) {
      throw new AscCliUnavailableError(
        [
          `The downloaded asc ${ASC_CLI_VERSION} failed its SHA-256 check; it was deleted.`,
          `Expected ${expected}`,
          `Got      ${actual}`,
          INSTALL_HINT,
        ].join("\n"),
      );
    }
    await fs.chmod(partial, 0o755);
    await fs.rename(partial, binary);
  } finally {
    await fs.rm(partial, { force: true });
  }
  return { path: binary, version: ASC_CLI_VERSION, source: "download" };
};
