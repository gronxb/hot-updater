import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import plist from "plist";
import { afterEach, describe, expect, it } from "vitest";

import { IosConfigParser } from "./iosParser";
import { formatPlistLikeXcode } from "./plistFormat";

/** An Info.plist as Xcode writes it: root <dict> at column 0, tabs, trailing newline. */
const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleDisplayName</key>
\t<string>Example</string>
\t<key>CFBundleURLTypes</key>
\t<array>
\t\t<dict>
\t\t\t<key>CFBundleURLSchemes</key>
\t\t\t<array>
\t\t\t\t<string>example</string>
\t\t\t</array>
\t\t</dict>
\t</array>
\t<key>LSRequiresIPhoneOS</key>
\t<true/>
\t<key>NSCameraUsageDescription</key>
\t<string>First line
\tsecond line starts with a tab</string>
\t<key>UIStatusBarStyle</key>
\t<integer>0</integer>
</dict>
</plist>
`;

/** The same plist with the root <dict> indented one tab, as plist.build writes it. */
const INDENTED_PLIST = plist
  .build(plist.parse(INFO_PLIST), {
    indent: "\t",
    pretty: true,
  })
  .concat("\n");

const EXAMPLE_PLIST = path.resolve(
  __dirname,
  "../../../../../examples/v0.77.0/ios/HotUpdaterExample/Info.plist",
);

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { force: true, recursive: true });
  }
});

const writeTemp = async (content: string) => {
  const dir = await mkdtemp(path.join(tmpdir(), "hot-updater-plist-"));
  tempDirs.push(dir);
  const file = path.join(dir, "Info.plist");
  await writeFile(file, content);
  return file;
};

describe("formatPlistLikeXcode", () => {
  it("lays a rebuilt Xcode plist out exactly as it was", () => {
    const built = plist.build(plist.parse(INFO_PLIST), {
      indent: "\t",
      pretty: true,
    });

    expect(built).not.toBe(INFO_PLIST);
    expect(formatPlistLikeXcode(built, INFO_PLIST)).toBe(INFO_PLIST);
  });

  it("keeps the text of a multi-line value", () => {
    const built = plist.build(plist.parse(INFO_PLIST), {
      indent: "\t",
      pretty: true,
    });

    expect(formatPlistLikeXcode(built, INFO_PLIST)).toContain(
      "<string>First line\n\tsecond line starts with a tab</string>",
    );
  });

  it("does not dedent the closing tag of a value that ends with a tab", () => {
    const value = "line\n\t";
    const built = plist.build({ A: value }, { indent: "\t", pretty: true });

    expect(built).toContain("\n\t</string>");
    expect(plist.parse(formatPlistLikeXcode(built))).toEqual({ A: value });
  });

  it("leaves a plist with a tab-indented root dict indented", () => {
    expect(INDENTED_PLIST).toContain("\n\t<dict>\n");
    const built = plist.build(plist.parse(INDENTED_PLIST), {
      indent: "\t",
      pretty: true,
    });

    expect(formatPlistLikeXcode(built, INDENTED_PLIST)).toBe(INDENTED_PLIST);
  });

  it("finds an indented root dict after blank lines and comments", () => {
    const previous = INDENTED_PLIST.replace(
      '<plist version="1.0">\n',
      '<plist version="1.0">\n\n\t<!-- generated -->\n\n',
    );
    const built = plist.build(plist.parse(previous), {
      indent: "\t",
      pretty: true,
    });

    expect(formatPlistLikeXcode(built, previous)).toBe(INDENTED_PLIST);
  });

  it("adds a trailing newline only when the file had one", () => {
    const built = plist.build({ A: "b" }, { indent: "\t", pretty: true });

    expect(formatPlistLikeXcode(built, "x\n").endsWith("</plist>\n")).toBe(
      true,
    );
    expect(formatPlistLikeXcode(built, "x").endsWith("</plist>")).toBe(true);
  });
});

describe("IosConfigParser writes", () => {
  it("adds a key as two lines and leaves the rest of the file alone", async () => {
    const file = await writeTemp(INFO_PLIST);
    const parser = new IosConfigParser([file]);

    await parser.set("HOT_UPDATER_CHANNEL", "production");

    expect(await readFile(file, "utf-8")).toBe(
      INFO_PLIST.replace(
        "</dict>\n</plist>",
        "\t<key>HOT_UPDATER_CHANNEL</key>\n\t<string>production</string>\n</dict>\n</plist>",
      ),
    );
    expect((await parser.get("HOT_UPDATER_CHANNEL")).value).toBe("production");
  });

  it("round-trip set, change, remove leaves the file byte-identical", async () => {
    const file = await writeTemp(INFO_PLIST);
    const parser = new IosConfigParser([file]);

    await parser.set("HOT_UPDATER_FINGERPRINT_HASH", "first");
    await parser.set("HOT_UPDATER_FINGERPRINT_HASH", "second");
    await parser.remove("HOT_UPDATER_FINGERPRINT_HASH");

    expect(await readFile(file, "utf-8")).toBe(INFO_PLIST);
  });

  it("round-trip leaves a tab-indented root dict byte-identical", async () => {
    const file = await writeTemp(INDENTED_PLIST);
    const parser = new IosConfigParser([file]);

    await parser.set("HOT_UPDATER_FINGERPRINT_HASH", "first");
    await parser.set("HOT_UPDATER_FINGERPRINT_HASH", "second");
    await parser.remove("HOT_UPDATER_FINGERPRINT_HASH");

    expect(await readFile(file, "utf-8")).toBe(INDENTED_PLIST);
  });

  it("round-trip leaves a checked-in example Info.plist byte-identical", async () => {
    const original = await readFile(EXAMPLE_PLIST, "utf-8");
    expect(original).toContain("\n\t<dict>\n");
    expect(original).not.toContain("HOT_UPDATER_ROUND_TRIP_TEST");
    const file = await writeTemp(original);
    const parser = new IosConfigParser([file]);

    await parser.set("HOT_UPDATER_ROUND_TRIP_TEST", "first");
    await parser.set("HOT_UPDATER_ROUND_TRIP_TEST", "second");
    await parser.remove("HOT_UPDATER_ROUND_TRIP_TEST");

    expect(await readFile(file, "utf-8")).toBe(original);
  });
});
