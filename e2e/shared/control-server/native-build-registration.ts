import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { BUILT_IN_MIN_BUNDLE_ID_PATTERN } from "../built-in-bundle-id.ts";

const execFileAsync = promisify(execFile);

type Platform = "ios" | "android";

/** The channel prefix the controller's proxy and deploys leave unnamespaced. */
export const NATIVE_BUILD_CHANNEL_PREFIX = "e2e-native-build-";

/**
 * The channel an E2E app binary registers under: its own. One registration
 * then serves every run of that binary, whose bytes are the same, and the
 * newest registration of another binary never shadows it. It is named by the
 * ID's build time, the part the built-in suffix leaves unique, which keeps
 * it short to type on the device.
 */
export const nativeBuildChannel = (minBundleId: string): string =>
  `${NATIVE_BUILD_CHANNEL_PREFIX}${minBundleId.slice(0, 13).replace("-", "")}`;

const isMachO = async (file: string): Promise<boolean> => {
  const handle = await fs.open(file, "r");
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(4), 0, 4, 0);
    if (bytesRead < 4) return false;
    const magic = buffer.readUInt32BE(0);
    // 64-bit and 32-bit Mach-O in either byte order, and universal binaries.
    return [
      0xcffaedfe, 0xcefaedfe, 0xfeedfacf, 0xfeedface, 0xcafebabe,
    ].includes(magic);
  } finally {
    await handle.close();
  }
};

/**
 * The MIN_BUNDLE_ID an E2E build compiled in, read from its code: the
 * dex files of an `.apk` or an `.aab`, or the `.app`'s Mach-O files. A
 * cached binary carries no other record of it.
 */
export async function readArtifactMinBundleId(
  artifactPath: string,
  platform: Platform,
): Promise<string> {
  const ids = new Set<string>();
  const collect = (bytes: Buffer) => {
    for (const match of bytes
      .toString("latin1")
      .matchAll(new RegExp(BUILT_IN_MIN_BUNDLE_ID_PATTERN.source, "g"))) {
      ids.add(match[0]);
    }
  };
  if (platform === "android") {
    const { stdout } = await execFileAsync(
      "unzip",
      [
        "-p",
        artifactPath,
        path.extname(artifactPath) === ".aab"
          ? "base/dex/classes*.dex"
          : "classes*.dex",
      ],
      { encoding: "buffer", maxBuffer: 1024 * 1024 * 1024 },
    );
    collect(stdout);
  } else {
    const entries = await fs.readdir(artifactPath, {
      recursive: true,
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const file = path.join(entry.parentPath, entry.name);
      if (await isMachO(file)) collect(await fs.readFile(file));
    }
  }
  if (ids.size !== 1) {
    throw new Error(
      `Expected one MIN_BUNDLE_ID compiled into ${artifactPath}, found ${ids.size}: ${[...ids].join(", ") || "none"}.`,
    );
  }
  return [...ids][0]!;
}

/**
 * Refuses an app whose dependencies really live outside the checkout that
 * builds its OTA. React Native names an asset by its real path relative to
 * the project, so a dependency reached through a symlink into another
 * checkout, such as a node_modules shared from the one that built the
 * native app, gives the OTA asset paths the native build never packaged,
 * and its built-in assets are downloaded instead of reused.
 */
export async function assertDependenciesInCheckout({
  checkoutDir,
  projectDir,
}: {
  checkoutDir: string;
  projectDir: string;
}): Promise<void> {
  const checkout = await fs.realpath(checkoutDir);
  const dependency = await fs.realpath(
    path.join(projectDir, "node_modules/react-native"),
  );
  if (!dependency.startsWith(`${checkout}${path.sep}`)) {
    throw new Error(
      `${projectDir} resolves react-native to ${dependency}, outside the checkout ${checkout}. Install the checkout's own dependencies: React Native names assets by their real paths, so the OTA's would not match the native build's.`,
    );
  }
}

/** What `hot-updater native-build import --json` prints on its last line. */
export type NativeBuildImportOutput = {
  readonly ok: boolean;
  readonly alreadyImported?: boolean;
  readonly nativeBuild: {
    readonly id: string;
    readonly min_bundle_id: string;
    readonly channel_id: string;
    readonly app_version: string | null;
    readonly artifact_kind: string;
  } | null;
  readonly problems?: readonly {
    readonly code: string;
    readonly message: string;
  }[];
};

/** The JSON line `native-build import --json` ends its output with. */
export function parseNativeBuildImportOutput(
  output: string,
): NativeBuildImportOutput {
  const line = output
    .trimEnd()
    .split("\n")
    .reverse()
    .find((candidate) => candidate.trimStart().startsWith("{"));
  if (line === undefined) {
    throw new Error(
      `hot-updater native-build import printed no JSON:\n${output.slice(-2000)}`,
    );
  }
  return JSON.parse(line) as NativeBuildImportOutput;
}
