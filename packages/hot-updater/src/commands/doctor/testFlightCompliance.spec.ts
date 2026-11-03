import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { type ConfigResponse, secret } from "@hot-updater/cli-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: string;

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  getCwd: () => root,
}));

import { checkTestFlightCompliance } from "./testFlightCompliance";

const PLIST = "ios/App/Info.plist";

const writePlist = (entries = "") => {
  const file = path.join(root, PLIST);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleName</key><string>App</string>
${entries}
</dict></plist>
`,
  );
};

const release = {
  bundleIdentifier: "com.example",
  signing: { ascApiKey: secret("asc-api-key") },
};

const check = (ios: Record<string, unknown>, adapter = "bare") =>
  checkTestFlightCompliance(
    {
      nativeBuild: { ios, android: {} },
      platform: { ios: { infoPlistPaths: [PLIST] } },
      build: async () => ({ name: adapter }),
    } as unknown as ConfigResponse,
    root,
  );

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-compliance-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("checkTestFlightCompliance", () => {
  it("warns of a scheme that can submit to TestFlight, with no key in Info.plist", async () => {
    writePlist();

    expect(await check({ release })).toEqual([
      {
        type: "warning",
        platform: "ios",
        code: "TESTFLIGHT_COMPLIANCE_UNSET",
        message:
          "TestFlight builds of release wait on an export compliance answer: Info.plist has no ITSAppUsesNonExemptEncryption.",
        resolution:
          "Set ITSAppUsesNonExemptEncryption in Info.plist, or answer each build in App Store Connect.",
        paths: [PLIST],
      },
    ]);
  });

  it("names the app config's key in an Expo project", async () => {
    writePlist();

    const [issue] = await check({ release }, "expo");

    expect(issue?.resolution).toBe(
      "Set ios.config.usesNonExemptEncryption in the app config, or answer each build in App Store Connect.",
    );
  });

  it.each(["<false/>", "<true/>"])(
    "says nothing once Info.plist declares %s",
    async (value) => {
      writePlist(`<key>ITSAppUsesNonExemptEncryption</key>${value}`);

      expect(await check({ release })).toEqual([]);
    },
  );

  it("says nothing of schemes that can't submit to TestFlight", async () => {
    writePlist();

    expect(
      await check({
        simulator: { bundleIdentifier: "com.example", simulator: true },
        debug: { ...release, configuration: "Debug" },
        archive: { bundleIdentifier: "com.example" },
      }),
    ).toEqual([]);
  });

  it("names only the schemes that can", async () => {
    writePlist();

    const [issue] = await check({
      release,
      staging: release,
      simulator: { bundleIdentifier: "com.example", simulator: true },
    });

    expect(issue?.message).toContain("release, staging");
    expect(issue?.message).not.toContain("simulator");
  });

  it("says nothing before a prebuild generates ios/", async () => {
    expect(await check({ release }, "expo")).toEqual([]);
  });
});
