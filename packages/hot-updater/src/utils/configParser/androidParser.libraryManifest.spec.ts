import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AndroidConfigParser } from "./androidParser";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { force: true, recursive: true });
  }
});

async function writeManifest(application: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hot-updater-manifest-"));
  tempDirs.push(dir);
  const manifestPath = path.join(dir, "AndroidManifest.xml");
  await writeFile(
    manifestPath,
    `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    ${application}
</manifest>
`,
  );
  return manifestPath;
}

describe("AndroidConfigParser on a brownfield library manifest", () => {
  it.each(["<application />", "<application></application>"])(
    "writes meta-data into an empty %s",
    async (application) => {
      const manifestPath = await writeManifest(application);
      const parser = new AndroidConfigParser([manifestPath]);

      await expect(
        parser.set("com.hotupdater.CHANNEL", "production"),
      ).resolves.toEqual({
        paths: [path.relative(process.cwd(), manifestPath)],
      });
      await parser.set("com.hotupdater.FINGERPRINT_HASH", "abc123");

      expect((await parser.get("com.hotupdater.CHANNEL")).value).toBe(
        "production",
      );
      expect((await parser.get("com.hotupdater.FINGERPRINT_HASH")).value).toBe(
        "abc123",
      );
      const xml = await readFile(manifestPath, "utf-8");
      expect(xml).toContain(
        '<meta-data android:name="com.hotupdater.CHANNEL" android:value="production" />',
      );
    },
  );

  it("leaves a manifest without an application element unchanged", async () => {
    const manifestPath = await writeManifest("");
    const before = await readFile(manifestPath, "utf-8");
    const parser = new AndroidConfigParser([manifestPath]);

    await expect(
      parser.set("com.hotupdater.CHANNEL", "production"),
    ).resolves.toEqual({ paths: [] });
    expect(await readFile(manifestPath, "utf-8")).toBe(before);
  });
});
