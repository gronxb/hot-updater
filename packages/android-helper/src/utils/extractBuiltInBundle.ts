import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";

import JSZip from "jszip";

/**
 * Copies the JavaScript bundle React Native's Gradle build packed into an
 * `.apk` (`assets/index.android.bundle`) or an `.aab`
 * (`base/assets/index.android.bundle`) to `outputPath`: the built-in bundle,
 * byte for byte, which no rebuild reproduces.
 */
export const extractBuiltInBundle = async ({
  artifactPath,
  outputPath,
}: {
  artifactPath: string;
  outputPath: string;
}): Promise<void> => {
  const entry =
    path.extname(artifactPath) === ".aab"
      ? "base/assets/index.android.bundle"
      : "assets/index.android.bundle";
  const zip = await JSZip.loadAsync(await fs.promises.readFile(artifactPath));
  const file = zip.file(entry);
  if (!file) {
    throw new Error(
      `${path.basename(artifactPath)} has no ${entry}. A release build packs its JavaScript bundle there unless the app's react { bundleAssetName } names another file.`,
    );
  }
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await pipeline(file.nodeStream(), fs.createWriteStream(outputPath));
};
