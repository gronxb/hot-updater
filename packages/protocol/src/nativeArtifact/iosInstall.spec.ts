import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { bytesSource, NativeArtifactError } from "./byteSource";
import {
  normalizeIosUdid,
  readIpaInstallInfo,
  readProfileServiceUdid,
} from "./iosInstall";

const PHONE = "00008030-001C2D3E4F5A6B7C";
const OLD_PHONE = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const LATER_PHONE = "00008110-000A1B2C3D4E5F60";

/** Bytes as a CMS message has around its plist: binary, with no `<?xml`. */
const CMS_PREFIX = new Uint8Array([0x30, 0x82, 0x1f, 0x6a, 0x06, 0x09, 0xff]);
const CMS_SUFFIX = new Uint8Array([0xa0, 0x82, 0x00, 0x00, 0x30, 0x80]);

const inCms = (plist: string) => {
  const body = new TextEncoder().encode(plist);
  const bytes = new Uint8Array(
    CMS_PREFIX.length + body.length + CMS_SUFFIX.length,
  );
  bytes.set(CMS_PREFIX);
  bytes.set(body, CMS_PREFIX.length);
  bytes.set(CMS_SUFFIX, CMS_PREFIX.length + body.length);
  return bytes;
};

const profile = ({
  devices,
  allDevices = false,
  getTaskAllow = false,
  expires = "2030-01-02T03:04:05Z",
}: {
  devices?: readonly string[];
  allDevices?: boolean;
  getTaskAllow?: boolean;
  expires?: string;
} = {}) =>
  inCms(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>AppIDName</key><string>App &amp; Co</string>
  <key>DeveloperCertificates</key><array><data>QUJD
  REVG</data></array>
  <key>Entitlements</key><dict><key>get-task-allow</key><${getTaskAllow}/></dict>
  <key>ExpirationDate</key><date>${expires}</date>
  ${allDevices ? "<key>ProvisionsAllDevices</key><true/>" : ""}
  ${devices === undefined ? "" : `<key>ProvisionedDevices</key><array>${devices.map((udid) => `<string>${udid}</string>`).join("")}</array>`}
</dict>
</plist>
`);

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.example.app</string>
  <key>CFBundleVersion</key><string>42</string>
  <key>CFBundleName</key><string>Example</string>
  <key>CFBundleDisplayName</key><string>Example &amp; Co</string>
</dict></plist>`;

const APP = "Payload/App.app";

const ipa = async (files: Record<string, Uint8Array | string>) => {
  const archive = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    archive.file(name, content, { compression: "DEFLATE" });
  }
  return bytesSource(await archive.generateAsync({ type: "uint8array" }));
};

const adHoc = (devices: readonly string[] = [PHONE, OLD_PHONE]) =>
  ipa({
    [`${APP}/Info.plist`]: INFO_PLIST,
    [`${APP}/embedded.mobileprovision`]: profile({ devices }),
    [`${APP}/App`]: "binary",
  });

const unreadable = (source: ReturnType<typeof bytesSource>) =>
  expect(readIpaInstallInfo(source)).rejects.toBeInstanceOf(
    NativeArtifactError,
  );

describe("readIpaInstallInfo", () => {
  it("reads what a manifest and an eligibility check need from an ad hoc IPA", async () => {
    expect(await readIpaInstallInfo(await adHoc())).toEqual({
      bundleId: "com.example.app",
      bundleVersion: "42",
      title: "Example & Co",
      distribution: "ad-hoc",
      devices: [PHONE.toLowerCase(), OLD_PHONE].sort(),
      expiresAtMs: Date.parse("2030-01-02T03:04:05Z"),
    });
  });

  it("falls back to the bundle name, then the bundle ID, for the title", async () => {
    const without = (key: string) =>
      INFO_PLIST.replace(
        new RegExp(`<key>${key}</key><string>[^<]*</string>`),
        "",
      );
    const named = await readIpaInstallInfo(
      await ipa({
        [`${APP}/Info.plist`]: without("CFBundleDisplayName"),
      }),
    );
    expect(named.title).toBe("Example");
    const bare = await readIpaInstallInfo(
      await ipa({
        [`${APP}/Info.plist`]: without("CFBundleDisplayName").replace(
          "<key>CFBundleName</key><string>Example</string>",
          "",
        ),
      }),
    );
    expect(bare.title).toBe("com.example.app");
  });

  it.each([
    ["development", { devices: [PHONE], getTaskAllow: true }, [PHONE]],
    ["enterprise", { allDevices: true }, []],
    ["store", {}, []],
  ] as const)(
    "tells a %s profile apart",
    async (distribution, options, listed) => {
      const info = await readIpaInstallInfo(
        await ipa({
          [`${APP}/Info.plist`]: INFO_PLIST,
          [`${APP}/embedded.mobileprovision`]: profile(options),
        }),
      );
      expect(info.distribution).toBe(distribution);
      expect(info.devices).toEqual(listed.map((udid) => udid.toLowerCase()));
    },
  );

  it("treats an IPA with no profile as one only a store installs", async () => {
    const info = await readIpaInstallInfo(
      await ipa({ [`${APP}/Info.plist`]: INFO_PLIST }),
    );
    expect(info).toMatchObject({
      distribution: "store",
      devices: [],
      expiresAtMs: null,
    });
  });

  it("lists only the devices every extension's profile lists too, and takes the first expiry", async () => {
    const info = await readIpaInstallInfo(
      await ipa({
        [`${APP}/Info.plist`]: INFO_PLIST,
        [`${APP}/embedded.mobileprovision`]: profile({
          devices: [PHONE, OLD_PHONE],
        }),
        [`${APP}/PlugIns/Share.appex/embedded.mobileprovision`]: profile({
          devices: [PHONE],
          expires: "2029-06-01T00:00:00Z",
        }),
        // A Watch app's profile lists watches, and installs on one.
        [`${APP}/Watch/Watch.app/embedded.mobileprovision`]: profile({
          devices: ["00008006-0000000000000000"],
          expires: "2028-01-01T00:00:00Z",
        }),
      }),
    );
    expect(info.devices).toEqual([PHONE.toLowerCase()]);
    expect(info.expiresAtMs).toBe(Date.parse("2029-06-01T00:00:00Z"));
  });

  it("refuses an IPA with too many extensions to read", async () => {
    const files: Record<string, Uint8Array | string> = {
      [`${APP}/Info.plist`]: INFO_PLIST,
      [`${APP}/embedded.mobileprovision`]: profile({ devices: [PHONE] }),
    };
    for (let i = 0; i < 17; i += 1) {
      files[`${APP}/PlugIns/E${i}.appex/embedded.mobileprovision`] = profile({
        devices: [PHONE],
      });
    }
    await unreadable(await ipa(files));
  });

  it("reads only the directory and the two entries, whatever else the IPA holds", async () => {
    const source = await ipa({
      [`${APP}/Info.plist`]: INFO_PLIST,
      [`${APP}/embedded.mobileprovision`]: profile({ devices: [PHONE] }),
      [`${APP}/App`]: new Uint8Array(4 * 1024 * 1024),
      [`${APP}/main.jsbundle`]: new Uint8Array(4 * 1024 * 1024),
    });
    const reads: number[] = [];
    await readIpaInstallInfo({
      size: source.size,
      read: (offset, length) => {
        reads.push(length);
        return source.read(offset, length);
      },
    });
    // The tail, the directory, then a local header and data for each entry.
    expect(reads).toHaveLength(6);
    expect(reads.reduce((sum, length) => sum + length, 0)).toBeLessThan(
      128 * 1024,
    );
  });

  describe("an IPA is untrusted", () => {
    it.each([
      ["no plist in the profile", new Uint8Array([1, 2, 3])],
      ["a plist that never closes", new TextEncoder().encode("<?xml <plist>")],
      ["a corrupt plist", inCms("<?xml?><plist><dict><key>a</key></plist>")],
      ["a plist that isn't a dict", inCms("<?xml?><plist><array/></plist>")],
      [
        "devices that aren't a list",
        inCms(
          "<?xml?><plist><dict><key>ProvisionedDevices</key><string>x</string></dict></plist>",
        ),
      ],
      [
        "a device that isn't a string",
        inCms(
          "<?xml?><plist><dict><key>ProvisionedDevices</key><array><integer>1</integer></array></dict></plist>",
        ),
      ],
      [
        "a date that isn't one",
        inCms(
          "<?xml?><plist><dict><key>ExpirationDate</key><date>soon</date></dict></plist>",
        ),
      ],
      [
        "an external entity",
        inCms(
          `<?xml?><!DOCTYPE plist [<!ENTITY x SYSTEM "file:///etc/passwd">]><plist><dict><key>AppIDName</key><string>&x;</string></dict></plist>`,
        ),
      ],
      [
        "a character reference past Unicode",
        inCms(
          "<?xml?><plist><dict><key>AppIDName</key><string>&#x110000;</string></dict></plist>",
        ),
      ],
    ])("refuses %s", async (_, bytes) => {
      await unreadable(
        await ipa({
          [`${APP}/Info.plist`]: INFO_PLIST,
          [`${APP}/embedded.mobileprovision`]: bytes,
        }),
      );
    });

    it("refuses a profile or Info.plist past 1 MiB without inflating it", async () => {
      const oversized = new Uint8Array(1024 * 1024 + 1);
      await unreadable(
        await ipa({
          [`${APP}/Info.plist`]: INFO_PLIST,
          [`${APP}/embedded.mobileprovision`]: oversized,
        }),
      );
      await unreadable(await ipa({ [`${APP}/Info.plist`]: oversized }));
    });

    it("refuses an archive with no app, or two", async () => {
      await unreadable(await ipa({ "Payload/readme.txt": "" }));
      await unreadable(
        await ipa({
          "Payload/A.app/Info.plist": INFO_PLIST,
          "Payload/B.app/Info.plist": INFO_PLIST,
        }),
      );
    });

    it.each([
      [
        "CFBundleIdentifier",
        "<key>CFBundleIdentifier</key><string>com.example.app</string>",
      ],
      ["CFBundleVersion", "<key>CFBundleVersion</key><string>42</string>"],
    ])("refuses an Info.plist with no %s", async (_, line) => {
      await unreadable(
        await ipa({ [`${APP}/Info.plist`]: INFO_PLIST.replace(line, "") }),
      );
    });

    it.each([
      ["open comments", "<!--".repeat(250_000)],
      ["open declarations", "<?".repeat(500_000)],
      ["open tags", "<".repeat(1_000_000)],
      ["open DOCTYPEs", "<!DOCTYPE".repeat(110_000)],
    ])("reads a megabyte of %s in linear time", async (_, junk) => {
      const started = Date.now();
      await unreadable(
        await ipa({
          [`${APP}/Info.plist`]: INFO_PLIST,
          [`${APP}/embedded.mobileprovision`]: inCms(
            `<?xml?><plist>${junk}</plist>`,
          ),
        }),
      );
      expect(Date.now() - started).toBeLessThan(5_000);
    });
  });

  it("negative control: an IPA signed before a device was added never lists it, and only a new IPA does", async () => {
    const signedBefore = await adHoc([PHONE]);
    const signedAfter = await adHoc([PHONE, LATER_PHONE]);

    const before = await readIpaInstallInfo(signedBefore);
    expect(before.devices).not.toContain(LATER_PHONE.toLowerCase());
    const after = await readIpaInstallInfo(signedAfter);
    expect(after.devices).toContain(LATER_PHONE.toLowerCase());
    // Reading again changes nothing: the old IPA's bytes are what iOS enforces.
    expect((await readIpaInstallInfo(signedBefore)).devices).toEqual(
      before.devices,
    );
  });
});

describe("normalizeIosUdid", () => {
  it.each([
    [PHONE, PHONE.toLowerCase()],
    [` ${OLD_PHONE}\n`, OLD_PHONE],
    [OLD_PHONE.toUpperCase(), OLD_PHONE],
  ])("takes %s", (value, normalized) => {
    expect(normalizeIosUdid(value)).toBe(normalized);
  });

  it.each([
    "",
    "not-a-udid",
    "00008030001C2D3E4F5A6B7C",
    `${OLD_PHONE}0`,
    "00008030-001C2D3E4F5A6B7Z",
    "6D3F4C0E-52C4-4C8B-9E0A-7B1E5A0C2F11",
  ])("refuses %j", (value) => {
    expect(normalizeIosUdid(value)).toBeNull();
  });
});

describe("readProfileServiceUdid", () => {
  const answer = (udid: string) =>
    inCms(`<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>IMEI</key><string>12 345678 901234 5</string>
  <key>UDID</key>
  <string>${udid}</string>
  <key>VERSION</key><string>21A329</string>
</dict></plist>`);

  it("takes the UDID from among the CMS message's binary bytes, as the device wrote it", () => {
    expect(readProfileServiceUdid(answer(PHONE))).toBe(PHONE);
  });

  it.each([
    ["nothing", new Uint8Array(0)],
    ["bytes with no plist", new Uint8Array(4096)],
    [
      "a plist that never closes",
      new TextEncoder().encode("<?xml <key>UDID</key><string>x</string>"),
    ],
    ["a malformed UDID", answer("../../etc/passwd")],
    ["markup in the UDID", answer(`${PHONE}<script>`)],
    [
      "no UDID key",
      inCms(
        "<?xml?><plist><dict><key>IMEI</key><string>1</string></dict></plist>",
      ),
    ],
    [
      "two UDIDs",
      inCms(
        `<?xml?><plist><dict><key>UDID</key><string>${PHONE}</string><key>UDID</key><string>${OLD_PHONE}</string></dict></plist>`,
      ),
    ],
  ])("finds no UDID in %s", (_, body) => {
    expect(readProfileServiceUdid(body)).toBeNull();
  });
});
