import { generateKeyPairSync, sign, verify } from "node:crypto";
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

/** The public key's meta-data as the Expo config plugin writes it: line breaks escaped. */
const PUBLIC_KEY = "com.hotupdater.PUBLIC_KEY";

describe("AndroidConfigParser on a manifest with a signing key", () => {
  it("keeps the public key through fingerprint and channel rewrites", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hot-updater-manifest-"));
    tempDirs.push(dir);
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const embedded = publicKey.trim().replaceAll("\n", "\\n");
    const manifestPath = path.join(dir, "AndroidManifest.xml");
    await writeFile(
      manifestPath,
      `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application>
    <meta-data android:name="${PUBLIC_KEY}" android:value="${embedded}"/>
  </application>
</manifest>
`,
    );
    const parser = new AndroidConfigParser([manifestPath]);
    const bundle = Buffer.from("console.log('signed bundle');");
    const signature = sign("sha256", bundle, privateKey);

    for (const [key, value] of [
      ["com.hotupdater.FINGERPRINT_HASH", "first-fingerprint"],
      ["com.hotupdater.CHANNEL", "staging"],
      ["com.hotupdater.FINGERPRINT_HASH", "second-fingerprint"],
    ] as const) {
      await parser.set(key, value);
      expect((await parser.get(key)).value).toBe(value);

      const xml = await readFile(manifestPath, "utf-8");
      const kept = xml.match(
        new RegExp(`android:name="${PUBLIC_KEY}" android:value="([^"]*)"`),
      )?.[1];
      expect(kept).toBe(embedded);
      expect(
        verify("sha256", bundle, kept!.replaceAll("\\n", "\n"), signature),
      ).toBe(true);
      expect(xml).not.toContain("&amp;#xA;");
    }
  });
});
