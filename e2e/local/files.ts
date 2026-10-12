import fs from "node:fs/promises";
import path from "node:path";

// Native key export and fingerprint generation modify these files before the
// control server starts its own backup. Restore the caller's originals last.
export const localMutableFiles = [
  "hot-updater.config.ts",
  ".env.hotupdater",
  ".gitignore",
  "keys/private-key.pem",
  "keys/public-key.pem",
  "fingerprint.json",
  "ios/.xcode.env.local",
  "ios/Podfile.lock",
  "ios/HotUpdaterExample.xcodeproj/project.pbxproj",
  "ios/HotUpdaterExample.xcworkspace/contents.xcworkspacedata",
  "ios/HotUpdaterExample/Info.plist",
  "ios/HotUpdaterExample/PrivacyInfo.xcprivacy",
  "android/app/src/main/AndroidManifest.xml",
  "android/app/src/debug/AndroidManifest.xml",
  "android/app/src/androidTest/AndroidManifest.xml",
  "src/e2eBuildConfig.js",
] as const;

export const lynxLocalMutableFiles = [
  "hot-updater.config.ts",
  ".env.hotupdater",
  ".gitignore",
  "keys/private-key.pem",
  "keys/public-key.pem",
  "fingerprint.json",
  "ios/Podfile.lock",
  "ios/Info.plist",
  "ios/MatrixHarness/NonProductionInfo.plist",
  "ios/SparklingGo.xcodeproj/project.pbxproj",
  "ios/SparklingGo.xcworkspace/contents.xcworkspacedata",
  "android/app/src/main/AndroidManifest.xml",
  "android/e2e-app/src/main/AndroidManifest.xml",
  "android/matrix-app/src/main/AndroidManifest.xml",
  "src/e2eApp/patchSurface.ts",
] as const;

export async function preserveFiles(
  root: string,
  names: readonly string[],
  backupDir?: string,
) {
  const saved = await Promise.all(
    names.map(async (name) => {
      const file = path.join(root, name);
      try {
        const stat = await fs.lstat(file);
        if (!stat.isFile())
          throw new Error(`Local E2E cannot replace a non-file: ${file}`);
        return {
          file,
          bytes: await fs.readFile(file),
          mode: stat.mode & 0o777,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return { file, bytes: undefined, mode: undefined };
      }
    }),
  );
  if (backupDir) {
    await fs.mkdir(backupDir, { mode: 0o700 });
    for (const [index, entry] of saved.entries()) {
      if (entry.bytes !== undefined) {
        await fs.writeFile(path.join(backupDir, String(index)), entry.bytes, {
          mode: 0o600,
        });
      }
    }
    await fs.writeFile(
      path.join(backupDir, "manifest.json"),
      JSON.stringify(
        saved.map((entry, index) => ({
          path: entry.file,
          mode: entry.mode,
          backup: entry.bytes === undefined ? null : String(index),
        })),
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
  return async () => {
    const errors: unknown[] = [];
    for (const entry of saved) {
      try {
        if (entry.bytes === undefined) await fs.rm(entry.file, { force: true });
        else {
          await fs.mkdir(path.dirname(entry.file), { recursive: true });
          await fs.writeFile(entry.file, entry.bytes, { mode: entry.mode });
          await fs.chmod(entry.file, entry.mode!);
        }
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        "Could not restore local E2E input files",
      );
  };
}
