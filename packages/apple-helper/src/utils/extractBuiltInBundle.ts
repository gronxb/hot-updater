import fs from "fs";
import path from "path";

import { execa } from "execa";

import { escapeUnzipPattern } from "./escapeUnzipPattern";

/** The file React Native's Xcode build phase writes into the `.app`. */
const BUILT_IN_BUNDLE = "main.jsbundle";

/**
 * Copies the JavaScript bundle React Native's Xcode build phase wrote into a
 * `.app` or an `.ipa` (`Payload/<App>.app/main.jsbundle`) to `outputPath`:
 * the built-in bundle, byte for byte, which no rebuild reproduces.
 */
export const extractBuiltInBundle = async ({
  artifactPath,
  outputPath,
}: {
  artifactPath: string;
  outputPath: string;
}): Promise<void> => {
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  if (path.extname(artifactPath) === ".app") {
    const source = path.join(artifactPath, BUILT_IN_BUNDLE);
    if (!fs.existsSync(source)) {
      throw new Error(
        `${path.basename(artifactPath)} has no ${BUILT_IN_BUNDLE}. A debug build loads its bundle from Metro instead.`,
      );
    }
    await fs.promises.copyFile(source, outputPath);
    return;
  }
  const { stdout } = await execa("unzip", ["-Z1", artifactPath]);
  const entry = stdout
    .split("\n")
    .find((name) => /^Payload\/[^/]+\.app\/main\.jsbundle$/u.test(name.trim()))
    ?.trim();
  if (entry === undefined) {
    throw new Error(
      `${path.basename(artifactPath)} has no Payload/<App>.app/${BUILT_IN_BUNDLE}.`,
    );
  }
  await execa("unzip", ["-p", artifactPath, escapeUnzipPattern(entry)], {
    stdout: { file: outputPath },
  });
};

/**
 * Unpacks a `.app` that `archiveAppBundle` stored as one zip file into
 * `outputPath`, which then holds the `.app` directory.
 */
export const extractAppBundle = async ({
  archivePath,
  outputPath,
}: {
  archivePath: string;
  outputPath: string;
}): Promise<void> => {
  await fs.promises.mkdir(outputPath, { recursive: true });
  await execa("ditto", ["-x", "-k", archivePath, outputPath]);
};

/**
 * A `.app` directory as one zip file, the way Finder and Xcode archive it,
 * so a simulator build uploads and downloads as a single artifact.
 */
export const archiveAppBundle = async ({
  appPath,
  outputPath,
}: {
  appPath: string;
  outputPath: string;
}): Promise<void> => {
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.promises.rm(outputPath, { force: true });
  await execa("ditto", [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    appPath,
    outputPath,
  ]);
};
