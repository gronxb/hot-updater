import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getCwd } from "@hot-updater/cli-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FingerprintFile, FingerprintResult } from "./common";
import {
  createAndInjectFingerprintFiles,
  createFingerprintJSON,
} from "./index";

const generated = vi.hoisted(() => ({
  ios: null as FingerprintResult | null,
  android: null as FingerprintResult | null,
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  getCwd: vi.fn(),
}));

vi.mock("./common", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./common")>()),
  ensureFingerprintConfig: vi.fn(async () => ({ adapter: "bare" })),
}));

vi.mock("./nativeSdk", () => ({
  assertNativeSdkEmbedsFingerprint: vi.fn(),
}));

vi.mock("./nativeFingerprint", () => ({
  nativeFingerprint: vi.fn(
    async (_cwd: string, { platform }: { platform: "ios" | "android" }) =>
      generated[platform],
  ),
}));

const platform = (name: string): FingerprintResult => ({
  engine: "hot-updater/interface@1",
  hash: `${name}-hash`,
  sources: [
    {
      type: "contents",
      id: "dependency:react-native-screens",
      contents: "react-native-screens@4.30.1",
      reasons: ["native-dependency"],
      hash: `${name}-screens`,
    },
    {
      type: "file",
      filePath: "src/specs/NativeDevice.ts",
      reasons: ["app-codegen-spec"],
      hash: `${name}-spec`,
    },
  ],
});

const fingerprint: FingerprintFile = {
  ios: platform("ios"),
  android: platform("android"),
  inputs: { adapter: "bare" },
};

let project: string;
const fingerprintJson = () => path.join(project, "fingerprint.json");
const read = () => fs.readFile(fingerprintJson(), "utf8");

beforeEach(async () => {
  vi.clearAllMocks();
  project = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-fp-json-"));
  vi.mocked(getCwd).mockReturnValue(project);
  generated.ios = platform("ios");
  generated.android = platform("android");
});

afterEach(async () => {
  await fs.rm(project, { recursive: true, force: true });
});

describe("fingerprint.json format", () => {
  it("writes JSON.stringify's two-space JSON with a final newline", async () => {
    await createFingerprintJSON(fingerprint);

    expect(await read()).toBe(`${JSON.stringify(fingerprint, null, 2)}\n`);
  });

  it("never records debugInfo", async () => {
    const withDebugInfo = {
      ...fingerprint,
      ios: {
        ...fingerprint.ios,
        sources: fingerprint.ios.sources.map((source) => ({
          ...source,
          debugInfo: { children: ["a", "b"] },
        })),
      },
    };

    const returned = await createFingerprintJSON(withDebugInfo);

    expect(returned).toBe(withDebugInfo);
    expect(await read()).not.toContain("debugInfo");
    expect(JSON.parse(await read())).toEqual(fingerprint);
  });
});

describe("writing fingerprint.json only when its data changes", () => {
  it("leaves a file that records the same data as it was formatted", async () => {
    // As a formatter with tabs might leave it.
    const formatted = JSON.stringify(fingerprint, null, "\t");
    await fs.writeFile(fingerprintJson(), formatted);

    await createFingerprintJSON(fingerprint);

    expect(await read()).toBe(formatted);
  });

  it("leaves an equal file whose keys are in another order", async () => {
    const reordered = JSON.stringify({
      inputs: fingerprint.inputs,
      android: fingerprint.android,
      ios: {
        sources: fingerprint.ios.sources,
        hash: fingerprint.ios.hash,
        engine: fingerprint.ios.engine,
      },
    });
    await fs.writeFile(fingerprintJson(), reordered);

    await createFingerprintJSON(fingerprint);

    expect(await read()).toBe(reordered);
  });

  it("doesn't rewrite fingerprint.json when fingerprint create finds nothing new", async () => {
    await createAndInjectFingerprintFiles();
    const first = await read();
    const formatted = `${JSON.stringify(JSON.parse(first), null, 4)}\n`;
    await fs.writeFile(fingerprintJson(), formatted);

    await createAndInjectFingerprintFiles();

    expect(await read()).toBe(formatted);
  });

  it("rewrites fingerprint.json when fingerprint create finds a change", async () => {
    await fs.writeFile(fingerprintJson(), JSON.stringify(fingerprint));
    generated.android = { ...platform("android"), hash: "android-next" };

    await createAndInjectFingerprintFiles();

    expect(JSON.parse(await read()).android.hash).toBe("android-next");
  });

  it.each([
    [
      "merge conflict markers",
      "<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> other\n",
    ],
    ["null", "null"],
    ["a missing platform", JSON.stringify({ ios: fingerprint.ios })],
    [
      "sources that aren't a list",
      JSON.stringify({
        ...fingerprint,
        android: { hash: "android-hash", sources: null },
      }),
    ],
    [
      "a source that isn't an object",
      JSON.stringify({
        ...fingerprint,
        ios: { ...fingerprint.ios, sources: [1] },
      }),
    ],
  ])("replaces a file with %s", async (_, text) => {
    await fs.writeFile(fingerprintJson(), text);

    await createFingerprintJSON(fingerprint);

    expect(JSON.parse(await read())).toEqual(fingerprint);
  });

  it("reports a generated fingerprint that isn't one", async () => {
    await expect(
      createFingerprintJSON({
        ...fingerprint,
        ios: { hash: "ios-hash" } as FingerprintResult,
      }),
    ).rejects.toThrow();
  });
});
