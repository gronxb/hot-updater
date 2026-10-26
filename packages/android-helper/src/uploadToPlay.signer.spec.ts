import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertPlaySigned } from "./uploadToPlay";

/** The JDK's signing tools, which Gradle needs too. */
const hasJdk = (() => {
  try {
    execFileSync("keytool", ["-help"], { stdio: "ignore" });
    execFileSync("jarsigner", ["-help"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let dir: string;

/** An `.aab`-shaped zip, signed by `jarsigner` with a key of `subject`. */
const bundle = async (name: string, subject?: string) => {
  const zip = new JSZip();
  zip.file("base/manifest/AndroidManifest.xml", "manifest");
  const file = path.join(dir, `${name}.aab`);
  await fs.writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
  if (subject) {
    const keystore = path.join(dir, `${name}.keystore`);
    execFileSync("keytool", [
      "-genkeypair",
      "-keystore",
      keystore,
      "-storepass",
      "android",
      "-keypass",
      "android",
      "-alias",
      "key",
      "-keyalg",
      "RSA",
      "-validity",
      "1",
      "-dname",
      subject,
    ]);
    execFileSync("jarsigner", [
      "-keystore",
      keystore,
      "-storepass",
      "android",
      file,
      "key",
    ]);
  }
  return file;
};

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "play-signer-"));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe.skipIf(!hasJdk)("assertPlaySigned", () => {
  it("refuses an .aab signed with the Android debug keystore's subject", async () => {
    const aab = await bundle("debug", "CN=Android Debug,O=Android,C=US");

    await expect(assertPlaySigned(aab)).rejects.toThrow(
      `Google Play refuses an .aab signed with the Android debug keystore, and ${aab} is. Set the scheme's signing.keystore, or a release signingConfig in android/app/build.gradle, then build again.`,
    );
  });

  it("takes an .aab signed with a release key", async () => {
    const aab = await bundle("release", "CN=Example Release,O=Example,C=US");

    await expect(assertPlaySigned(aab)).resolves.toBeUndefined();
  });

  it("leaves an .aab keytool reads no signer from to Google Play", async () => {
    const aab = await bundle("unsigned");

    await expect(assertPlaySigned(aab)).resolves.toBeUndefined();
  });
});
