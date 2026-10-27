import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { bytesSource, NativeArtifactError } from "./byteSource";
import { readNativeArtifact } from "./readNativeArtifact";
import { findZipEntry, openZipEntry, readZipDirectory } from "./zip";

// An upload is untrusted: what a crafted artifact breaks must be a refusal
// (UNREADABLE), never a crash, a hang, or memory filled by a zip bomb.

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const fixture = (name: string) => readFileSync(join(fixtures, name));

const CENTRAL_HEADER = 0x02014b50;

const zip = async (
  files: Record<string, Uint8Array | string>,
  options: {
    symlinks?: readonly string[];
  } = {},
): Promise<Uint8Array> => {
  const archive = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    archive.file(name, content, {
      compression: "DEFLATE",
      ...(options.symlinks?.includes(name)
        ? { unixPermissions: 0o120777 }
        : { unixPermissions: 0o100644 }),
    });
  }
  return archive.generateAsync({ type: "uint8array", platform: "UNIX" });
};

/**
 * Rewrites the central directory record of `name`: its declared
 * uncompressed size, or its name (same length), as a crafted archive would.
 */
const patchCentralRecord = (
  bytes: Uint8Array,
  name: string,
  patch: { uncompressedSize?: number; rename?: string },
) => {
  const out = bytes.slice();
  const data = new DataView(out.buffer);
  const encoded = new TextEncoder().encode(name);
  for (let i = 0; i + 46 < out.length; i += 1) {
    if (data.getUint32(i, true) !== CENTRAL_HEADER) continue;
    const length = data.getUint16(i + 28, true);
    const entryName = out.subarray(i + 46, i + 46 + length);
    if (
      length !== encoded.length ||
      !entryName.every((byte, k) => byte === encoded[k])
    ) {
      continue;
    }
    if (patch.uncompressedSize !== undefined) {
      data.setUint32(i + 24, patch.uncompressedSize, true);
    }
    if (patch.rename !== undefined) {
      out.set(new TextEncoder().encode(patch.rename), i + 46);
    }
    return out;
  }
  throw new Error(`no central record for ${name}`);
};

const aab = (overrides: Record<string, Uint8Array | string> = {}) => ({
  "base/manifest/AndroidManifest.xml": fixture("release.pb"),
  "base/dex/classes.dex": fixture("classes.dex"),
  "base/assets/index.android.bundle": "console.log(1);",
  ...overrides,
});

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a refusal");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(NativeArtifactError);
      return (error as NativeArtifactError).message;
    },
  );

describe("reading an untrusted artifact", () => {
  it("stops a zip bomb at the size its entry declares, and refuses it", async () => {
    // 64 MB of zeros deflate to about 64 KB; the header claims 1 KB.
    const bomb = patchCentralRecord(
      await zip(
        aab({
          "base/assets/index.android.bundle": new Uint8Array(64 * 1024 * 1024),
        }),
      ),
      "base/assets/index.android.bundle",
      { uncompressedSize: 1024 },
    );
    const source = bytesSource(bomb);
    const entry = findZipEntry(
      await readZipDirectory(source),
      "base/assets/index.android.bundle",
    )!;
    const reader = (await openZipEntry(source, entry)).getReader();
    const message = await refusal(
      (async () => {
        for (let next = await reader.read(); !next.done; ) {
          next = await reader.read();
        }
      })(),
    );
    expect(message).toContain("inflates past the size it declares");
  });

  it("refuses an entry streamed out whole that declares more than it may hold", async () => {
    const source = bytesSource(await zip(aab()));
    const entry = findZipEntry(
      await readZipDirectory(source),
      "base/assets/index.android.bundle",
    )!;
    expect(
      await refusal(openZipEntry(source, entry, { maxBytes: 4 })),
    ).toContain("larger than");
  });

  it("refuses a manifest that declares more than any manifest holds, before reading it", async () => {
    const crafted = patchCentralRecord(
      await zip(aab()),
      "base/manifest/AndroidManifest.xml",
      { uncompressedSize: 0x7fff_ffff },
    );
    expect(
      await refusal(readNativeArtifact(bytesSource(crafted), "app.aab")),
    ).toContain("larger than 16 MB");
  });

  it("reads a dex whose size is understated only that far, and refuses what is left", async () => {
    const crafted = patchCentralRecord(
      await zip(aab()),
      "base/dex/classes.dex",
      { uncompressedSize: 64 },
    );
    await refusal(readNativeArtifact(bytesSource(crafted), "app.aab"));
  });

  it("matches no entry whose name escapes the archive, and refuses streaming one", async () => {
    const bytes = await zip(
      aab({
        "../../etc/passwd": "root",
        "/absolute/AndroidManifest.xml": "x",
        "base/../base/manifest/AndroidManifest.xml": "x",
      }),
    );
    const entries = await readZipDirectory(bytesSource(bytes));
    expect(
      entries
        // JSZip adds an entry for each folder too.
        .filter(({ name, unsafe }) => unsafe && !name.endsWith("/"))
        .map(({ name }) => name)
        .sort(),
    ).toEqual(
      [
        "../../etc/passwd",
        "/absolute/AndroidManifest.xml",
        "base/../base/manifest/AndroidManifest.xml",
      ].sort(),
    );
    // The reader takes the real manifest and ignores the others.
    await expect(
      readNativeArtifact(bytesSource(bytes), "app.aab"),
    ).resolves.toMatchObject({ appId: "com.example.app" });
    const traversal = entries.find(({ name }) => name === "../../etc/passwd")!;
    expect(
      await refusal(openZipEntry(bytesSource(bytes), traversal)),
    ).toContain("no artifact holds");
  });

  it("refuses a built-in bundle or manifest that is a symbolic link", async () => {
    for (const name of [
      "base/assets/index.android.bundle",
      "base/manifest/AndroidManifest.xml",
    ]) {
      const bytes = await zip(aab({ [name]: "/etc/passwd" }), {
        symlinks: [name],
      });
      expect(
        await refusal(readNativeArtifact(bytesSource(bytes), "app.aab")),
      ).toContain("symbolic link");
    }
  });

  it("refuses an archive that holds an entry it reads twice", async () => {
    const crafted = patchCentralRecord(
      await zip(
        aab({ "base/manifest/AndroidManifesT.xml": fixture("debuggable.pb") }),
      ),
      "base/manifest/AndroidManifesT.xml",
      { rename: "base/manifest/AndroidManifest.xml" },
    );
    expect(
      await refusal(readNativeArtifact(bytesSource(crafted), "app.aab")),
    ).toContain("more than once");
  });

  it("refuses a truncated archive", async () => {
    const bytes = await zip(aab());
    for (const length of [0, 21, bytes.length >> 1, bytes.length - 10]) {
      await refusal(
        readNativeArtifact(bytesSource(bytes.subarray(0, length)), "app.aab"),
      );
    }
  });

  it("refuses a truncated or malformed Info.plist and manifest", async () => {
    const plist = fixture("Info.plist");
    for (const bad of [
      plist.subarray(0, plist.length >> 1),
      plist.subarray(0, 12),
      new TextEncoder().encode("<plist><dict><key>a</key>"),
      new TextEncoder().encode(
        `<plist>${"<array>".repeat(10_000)}${"</array>".repeat(10_000)}</plist>`,
      ),
    ]) {
      const bytes = await zip({
        "Payload/App.app/Info.plist": bad,
        "Payload/App.app/App": fixture("App"),
        "Payload/App.app/main.jsbundle": "x",
      });
      await refusal(readNativeArtifact(bytesSource(bytes), "App.ipa"));
    }
    for (const bad of [
      fixture("release.pb").subarray(0, 40),
      fixture("release.axml").subarray(0, 40),
      new Uint8Array(512).fill(0xff),
    ]) {
      await refusal(
        readNativeArtifact(
          bytesSource(
            await zip(aab({ "base/manifest/AndroidManifest.xml": bad })),
          ),
          "app.aab",
        ),
      );
      await refusal(
        readNativeArtifact(
          bytesSource(
            await zip({
              "AndroidManifest.xml": bad,
              "classes.dex": fixture("classes.dex"),
            }),
          ),
          "app.apk",
        ),
      );
    }
  });

  it("refuses an archive it can't read in time", async () => {
    expect(
      await refusal(
        readNativeArtifact(bytesSource(await zip(aab())), "app.aab", {
          timeoutMs: -1,
        }),
      ),
    ).toContain("took too long");
  });
});
