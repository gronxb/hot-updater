// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createMemoryAdapter,
  type IosDeviceRow,
  meterReads,
  type NativeBuildRow,
  type StorageAdapter,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => new Request("https://console.example.com/_serverFn/x"),
}));
vi.mock("virtual:hot-updater-console/request-guard", () => ({
  default: undefined,
}));

import { NATIVE_BUILD_INSTALL_LINK_TTL_MS } from "../native-builds";
import {
  CONSOLE_SECRET_ENV,
  createNativeBuildDownloadToken,
  verifyNativeBuildDownloadToken,
} from "./nativeBuildDownloadLink";
import {
  checkNativeBuildInstall,
  httpRangeSource,
  RangeSourceError,
  readNativeBuildInstallInfo,
  readNativeBuildIpaDevices,
  serveNativeBuildManifest,
} from "./nativeBuildInstall";

const SECRET = "a-console-secret-of-at-least-32-characters";
const BUILD = "019a0000-0000-7000-8000-00000000b001";
const OTHER_BUILD = "019a0000-0000-7000-8000-00000000b002";
const PHONE = "00008030-001C2D3E4F5A6B7C";
const LATER_PHONE = "00008110-000A1B2C3D4E5F60";
const STORAGE_URL =
  "https://storage.example.com/app.ipa?X-Sig=secret-signature";
const APP = "Payload/App.app";

const mobileprovision = (body: string) =>
  `\u0000\u0001<?xml version="1.0"?><plist version="1.0"><dict>${body}</dict></plist>\u0002`;
const adHocProfile = (
  devices: readonly string[],
  expires = "2099-01-01T00:00:00Z",
) =>
  mobileprovision(
    `<key>ExpirationDate</key><date>${expires}</date><key>ProvisionedDevices</key><array>${devices
      .map((udid) => `<string>${udid}</string>`)
      .join("")}</array>`,
  );
const INFO_PLIST = `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.app</string><key>CFBundleVersion</key><string>42</string><key>CFBundleDisplayName</key><string>Tom &amp; Jerry's &lt;App&gt;</string></dict></plist>`;

const ipaBytes = async (
  profile: string,
  padding = 1024,
  bundleId = "com.example.app",
) => {
  const archive = new JSZip();
  archive.file(
    `${APP}/Info.plist`,
    INFO_PLIST.replace("com.example.app", bundleId),
  );
  // Incompressible bytes, so the file is as large as it looks.
  const large = new Uint8Array(padding);
  for (let i = 0; i < padding; i += 1) large[i] = (i * 2654435761) >>> 24;
  archive.file(`${APP}/App`, large, { compression: "STORE" });
  archive.file(`${APP}/embedded.mobileprovision`, profile, {
    compression: "DEFLATE",
  });
  return archive.generateAsync({ type: "uint8array" });
};

/** Storage's HTTP server over `bytes`, counting what it serves. */
const rangeServer = (bytes: Uint8Array) => {
  const served = { requests: 0, bytes: 0, urls: new Set<string>() };
  const fetch = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      served.requests += 1;
      served.urls.add(String(input));
      const range = /^bytes=(\d+)-(\d+)$/u.exec(
        new Headers(init?.headers).get("range") ?? "",
      );
      if (range === null) return new Response(bytes as BufferSource);
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), bytes.length - 1);
      const body = bytes.subarray(start, end + 1);
      served.bytes += body.length;
      return new Response(body as BufferSource, {
        status: 206,
        headers: { "content-range": `bytes ${start}-${end}/${bytes.length}` },
      });
    },
  ) as unknown as typeof globalThis.fetch;
  return { fetch, served };
};

const storageOf = (overrides: Partial<StorageAdapter> = {}): StorageAdapter =>
  ({
    name: "s3",
    protocol: "s3",
    getDownloadUrl: vi.fn(async () => ({ url: STORAGE_URL })),
    ...overrides,
  }) as unknown as StorageAdapter;

const rowOf = (size: number, overrides: Partial<NativeBuildRow> = {}) =>
  ({
    id: BUILD,
    artifact_kind: "ipa",
    artifact_storage_uri: "s3://bucket/native-builds/ios/app.ipa",
    byte_size: size,
    ...overrides,
  }) as NativeBuildRow;

const coreOf = (
  row: NativeBuildRow | null,
  registry: readonly IosDeviceRow[] = [],
) => ({
  getNativeBuild: vi.fn(async () => row),
  findIosDevice: vi.fn(
    async (udid: string) =>
      registry.find((device) => device.udid === udid.toLowerCase()) ?? null,
  ),
  listIosDevices: vi.fn(
    async ({ status }: { readonly status?: IosDeviceRow["status"] } = {}) =>
      registry.filter(
        (device) => status === undefined || device.status === status,
      ),
  ),
});

const registryRow = (udid: string, name: string) =>
  ({
    id: `device-${name}`,
    udid: udid.toLowerCase(),
    name,
    status: "registered",
  }) as IosDeviceRow;

beforeEach(() => {
  vi.stubEnv(CONSOLE_SECRET_ENV, SECRET);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("httpRangeSource", () => {
  const body200 = () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(new Uint8Array(1024)),
      cancel,
    });
    return { stream, cancel };
  };

  it("stops at a 200 to a Range request, cancelling the body before reading any of it", async () => {
    const { stream, cancel } = body200();
    const fetch = vi.fn(async () => new Response(stream)) as never;
    const source = httpRangeSource({ url: STORAGE_URL, size: 1 << 30, fetch });

    const refused = source.read(0, 16);
    await expect(refused).rejects.toThrow(RangeSourceError);
    await expect(refused).rejects.toThrow(/answered 200/u);
    expect(cancel).toHaveBeenCalled();
  });

  it("stops at a 200 even with a Content-Range that fits", async () => {
    const { stream, cancel } = body200();
    const fetch = vi.fn(
      async () =>
        new Response(stream, {
          headers: { "content-range": "bytes 0-19/20" },
        }),
    ) as never;

    await expect(
      httpRangeSource({ url: STORAGE_URL, size: 20, fetch }).read(0, 16),
    ).rejects.toThrow(/answered 200/u);
    expect(cancel).toHaveBeenCalled();
  });

  it.each([
    ["no Content-Range", {}, 206],
    ["another offset", { "content-range": "bytes 5-20/100" }, 206],
    ["another end", { "content-range": "bytes 0-5/100" }, 206],
    ["another file's size", { "content-range": "bytes 0-15/999" }, 206],
    ["a refusal", { "content-range": "bytes */100" }, 416],
  ])("refuses an answer with %s", async (_, headers, status) => {
    const fetch = vi.fn(
      async () =>
        new Response(status === 416 ? null : new Uint8Array(16), {
          status,
          headers,
        }),
    ) as never;
    await expect(
      httpRangeSource({ url: STORAGE_URL, size: 100, fetch }).read(0, 16),
    ).rejects.toThrow(RangeSourceError);
  });

  it("refuses a server that sends more or less than it was asked", async () => {
    const answering = (length: number) =>
      vi.fn(
        async () =>
          new Response(new Uint8Array(length), {
            status: 206,
            headers: { "content-range": "bytes 0-99/100" },
          }),
      ) as never;
    await expect(
      httpRangeSource({
        url: STORAGE_URL,
        size: 100,
        fetch: answering(101),
      }).read(0, 16),
    ).rejects.toThrow(/more than/u);
    await expect(
      httpRangeSource({
        url: STORAGE_URL,
        size: 100,
        fetch: answering(99),
      }).read(0, 16),
    ).rejects.toThrow(/less than/u);
  });

  it("asks with a Range header, and reuses bytes it already has", async () => {
    const bytes = new Uint8Array(200_000).map((_, i) => i % 251);
    const { fetch, served } = rangeServer(bytes);
    const source = httpRangeSource({
      url: STORAGE_URL,
      size: bytes.length,
      fetch,
    });

    expect([...(await source.read(100, 4))]).toEqual([100, 101, 102, 103]);
    expect([...(await source.read(104, 2))]).toEqual([104, 105]);

    expect(served.requests).toBe(1);
  });

  it("gives what's left at the end of the file, and nothing past it", async () => {
    const bytes = new Uint8Array(10).map((_, i) => i);
    const { fetch } = rangeServer(bytes);
    const source = httpRangeSource({ url: STORAGE_URL, size: 10, fetch });

    expect([...(await source.read(8, 16))]).toEqual([8, 9]);
    expect(await source.read(10, 16)).toHaveLength(0);
  });

  it("stops before downloading much of a file, however many reads ask", async () => {
    const bytes = new Uint8Array(64 * 1024 * 1024);
    const { fetch, served } = rangeServer(bytes);
    const source = httpRangeSource({
      url: STORAGE_URL,
      size: bytes.length,
      fetch,
    });

    await expect(source.read(0, bytes.length)).rejects.toThrow(/too much/u);
    expect(served.requests).toBe(0);
    await expect(
      (async () => {
        for (let i = 0; i < 100; i += 1) {
          await source.read(i * 128 * 1024, 16);
        }
      })(),
    ).rejects.toThrow(/too many/u);
    expect(served.requests).toBe(24);
  });
});

describe("readNativeBuildInstallInfo", () => {
  it("reads a large IPA in at most 4 requests, and a sliver of its bytes", async () => {
    const bytes = await ipaBytes(adHocProfile([PHONE]), 32 * 1024 * 1024);
    const { fetch, served } = rangeServer(bytes);

    const info = await readNativeBuildInstallInfo(
      rowOf(bytes.length),
      storageOf(),
      fetch,
    );

    expect(info).toMatchObject({
      bundleId: "com.example.app",
      distribution: "ad-hoc",
    });
    expect(served.requests).toBeLessThanOrEqual(4);
    expect(served.bytes).toBeLessThan(bytes.length / 64);
    expect([...served.urls]).toEqual([STORAGE_URL]);
  });

  it.each([
    [
      "a storage with no download URL",
      storageOf({ getDownloadUrl: undefined }),
    ],
    [
      "an insecure download URL",
      storageOf({
        getDownloadUrl: vi.fn(async () => ({
          url: "http://storage.example.com/app.ipa",
        })),
      }),
    ],
    [
      "a download URL only the storage can read",
      storageOf({
        getDownloadUrl: vi.fn(async () => ({ url: "/private/app.ipa" })),
      }),
    ],
    [
      "a storage that fails to give one",
      storageOf({
        getDownloadUrl: vi.fn(async () => {
          throw new Error("no");
        }),
      }),
    ],
  ])("says nothing for %s, without a request", async (_, storage) => {
    const fetch = vi.fn() as never;
    expect(
      await readNativeBuildInstallInfo(rowOf(100), storage, fetch),
    ).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("gives up on a storage that answers 200, having taken nothing, and never logs its URL", async () => {
    let pulled = 0;
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull: (controller) => {
              pulled += 1;
              controller.enqueue(new Uint8Array(1024 * 1024));
            },
          }),
        ),
    ) as never;

    expect(
      await readNativeBuildInstallInfo(
        rowOf(4 * 1024 * 1024 * 1024),
        storageOf(),
        fetch,
      ),
    ).toBeNull();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(pulled).toBeLessThanOrEqual(1);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
      "secret-signature",
    );
  });

  it("reads no storage for an artifact that isn't an IPA", async () => {
    const storage = storageOf();
    expect(
      await readNativeBuildInstallInfo(
        rowOf(100, { artifact_kind: "apk" }),
        storage,
      ),
    ).toBeNull();
    expect(storage.getDownloadUrl).not.toHaveBeenCalled();
  });
});

describe("checkNativeBuildInstall", () => {
  const check = async (
    profile: string,
    udid: string | undefined,
    {
      now,
      registry = [],
      canApprove,
    }: {
      now?: number;
      registry?: readonly IosDeviceRow[];
      canApprove?: () => Promise<boolean>;
    } = {},
  ) => {
    const bytes = await ipaBytes(profile);
    const { fetch, served } = rangeServer(bytes);
    const core = coreOf(rowOf(bytes.length), registry);
    const result = await checkNativeBuildInstall(
      BUILD,
      udid,
      { core, storage: storageOf() },
      { fetch, now: now ?? Date.now(), canApprove },
    );
    return { result, core, served };
  };

  it("reads one row and the IPA's few parts, and asks nothing else", async () => {
    const { result, core, served } = await check(adHocProfile([PHONE]), PHONE);

    expect(result).toMatchObject({
      status: "installable",
      device: "included",
      registry: null,
    });
    expect(core.getNativeBuild).toHaveBeenCalledTimes(1);
    expect(core.findIosDevice).not.toHaveBeenCalled();
    expect(served.requests).toBeLessThanOrEqual(4);
  });

  it("reads the registry's row of a phone the IPA doesn't list, once, and only then", async () => {
    const kim = registryRow(LATER_PHONE, "Kim's iPhone");
    const { result, core } = await check(adHocProfile([PHONE]), LATER_PHONE, {
      registry: [kim],
    });
    expect(result).toMatchObject({ device: "not-included", registry: kim });
    expect(core.findIosDevice).toHaveBeenCalledTimes(1);
    const unknown = await check(adHocProfile([PHONE]), undefined);
    expect(unknown.core.findIosDevice).not.toHaveBeenCalled();
  });

  it("asks whether the viewer approves only under Apple's refusal of the device", async () => {
    const canApprove = vi.fn(async () => true);
    const refused = {
      ...registryRow(LATER_PHONE, "Kim's iPhone"),
      status: "approved",
      apple_error: "The maximum number of devices was reached.",
    } as IosDeviceRow;
    const { result } = await check(adHocProfile([PHONE]), LATER_PHONE, {
      registry: [refused],
      canApprove,
    });
    expect(result).toMatchObject({ registry: refused, canApprove: true });
    expect(canApprove).toHaveBeenCalledTimes(1);

    canApprove.mockClear();
    const plain = await check(adHocProfile([PHONE]), LATER_PHONE, {
      registry: [registryRow(LATER_PHONE, "Kim's iPhone")],
      canApprove,
    });
    expect(plain.result).toMatchObject({ canApprove: false });
    const listed = await check(adHocProfile([PHONE]), PHONE, { canApprove });
    expect(listed.result).toMatchObject({ canApprove: false });
    expect(canApprove).not.toHaveBeenCalled();
  });

  it("compares a UDID whatever its case", async () => {
    const { result } = await check(
      adHocProfile([PHONE.toLowerCase()]),
      PHONE.toUpperCase(),
    );
    expect(result).toMatchObject({ device: "included" });
  });

  it("says a phone the IPA doesn't list isn't in it", async () => {
    const { result } = await check(adHocProfile([PHONE]), LATER_PHONE);
    expect(result).toMatchObject({
      status: "installable",
      device: "not-included",
    });
  });

  it("says nothing of a phone with no UDID, or text that isn't one", async () => {
    for (const udid of [undefined, "not-a-udid"]) {
      const { result } = await check(adHocProfile([PHONE]), udid);
      expect(result).toMatchObject({ device: "unknown" });
    }
  });

  it("signs an Install link that verifies for this build and lasts an hour", async () => {
    const now = Date.now();
    const { result } = await check(adHocProfile([PHONE]), PHONE, { now });
    if (result.status !== "installable" || result.link.status !== "issued") {
      throw new Error(`no link: ${JSON.stringify(result)}`);
    }

    const { token, expiresAt } = result.link;
    expect(Date.parse(expiresAt) - now).toBe(NATIVE_BUILD_INSTALL_LINK_TTL_MS);
    expect(
      await verifyNativeBuildDownloadToken(SECRET, BUILD, token, now),
    ).toBe("valid");
    expect(
      await verifyNativeBuildDownloadToken(SECRET, OTHER_BUILD, token, now),
    ).toBe("invalid");
    expect(
      await verifyNativeBuildDownloadToken(
        SECRET,
        BUILD,
        token,
        now + NATIVE_BUILD_INSTALL_LINK_TTL_MS,
      ),
    ).toBe("expired");
  });

  it("says a Console without its secret can't sign, without a link", async () => {
    vi.stubEnv(CONSOLE_SECRET_ENV, "");
    const { result } = await check(adHocProfile([PHONE]), PHONE);
    expect(result).toMatchObject({
      status: "installable",
      link: { status: "no-secret" },
    });
  });

  it("tells an App Store export apart, with no link", async () => {
    const { result } = await check(mobileprovision(""), PHONE);
    expect(result).toEqual({ status: "store" });
  });

  it("says a profile has expired, with no link", async () => {
    const { result } = await check(
      adHocProfile([PHONE], "2020-01-01T00:00:00Z"),
      PHONE,
    );
    expect(result).toEqual({
      status: "expired",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
  });

  it("is unavailable for a missing build, and for a storage that ignores Range", async () => {
    expect(
      await checkNativeBuildInstall(BUILD, PHONE, {
        core: coreOf(null),
        storage: storageOf(),
      }),
    ).toEqual({ status: "unavailable" });
    expect(
      await checkNativeBuildInstall(
        BUILD,
        PHONE,
        { core: coreOf(rowOf(100)), storage: storageOf() },
        { fetch: vi.fn(async () => new Response("all of it")) as never },
      ),
    ).toEqual({ status: "unavailable" });
  });

  it("negative control: a device added to the account later stays out of the old IPA, and only a newer IPA has it", async () => {
    const before = await check(adHocProfile([PHONE]), LATER_PHONE);
    expect(before.result).toMatchObject({ device: "not-included" });
    const after = await check(adHocProfile([PHONE, LATER_PHONE]), LATER_PHONE);
    expect(after.result).toMatchObject({ device: "included" });
    const again = await check(adHocProfile([PHONE]), LATER_PHONE);
    expect(again.result).toMatchObject({ device: "not-included" });
  });
});

describe("checkNativeBuildInstall: the newer build a registered device's row names", () => {
  // One registry for every scheme: the row keeps the newest build the CLI
  // checked, whichever scheme built it.
  const NEWER = OTHER_BUILD;
  const production = {
    id: BUILD,
    platform: "ios",
    channel_id: "production",
    is_sandbox: false,
    export_method: "ad-hoc",
    artifact_kind: "ipa",
  } as const;
  type Ipa = {
    readonly row: Partial<NativeBuildRow>;
    readonly devices: readonly string[];
    readonly bundleId?: string;
  };
  const check = async (
    newer: Ipa | null,
    base: Partial<NativeBuildRow> = {},
  ) => {
    const builds: (Ipa & { readonly id: string })[] = [
      { id: BUILD, row: { ...production, ...base }, devices: [PHONE] },
      ...(newer === null ? [] : [{ id: NEWER, ...newer }]),
    ];
    const files = new Map<string, Uint8Array>();
    const rows = new Map<string, NativeBuildRow>();
    for (const { id, row, devices, bundleId } of builds) {
      const bytes = await ipaBytes(adHocProfile(devices), 1024, bundleId);
      const uri = `s3://bucket/native-builds/ios/${id}.ipa`;
      files.set(`https://storage.example.com/${id}.ipa`, bytes);
      rows.set(id, {
        ...production,
        ...row,
        id,
        artifact_storage_uri: uri,
        byte_size: bytes.length,
      } as NativeBuildRow);
    }
    const urls: string[] = [];
    const servers = new Map(
      [...files].map(([url, bytes]) => [url, rangeServer(bytes)]),
    );
    const fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        urls.push(String(input));
        return servers.get(String(input))!.fetch(input, init);
      },
    ) as unknown as typeof globalThis.fetch;
    const kim = {
      ...registryRow(LATER_PHONE, "Kim's iPhone"),
      build_id: NEWER,
    } as IosDeviceRow;
    const core = {
      getNativeBuild: vi.fn(async (id: string) => rows.get(id) ?? null),
      findIosDevice: vi.fn(async () => kim),
    };
    const storage = storageOf({
      getDownloadUrl: vi.fn(async ({ storageUri }: { storageUri: string }) => ({
        url: `https://storage.example.com/${storageUri.split("/").at(-1)}`,
      })),
    });
    const result = await checkNativeBuildInstall(
      BUILD,
      LATER_PHONE,
      { core, storage },
      { fetch },
    );
    return { result, core, urls };
  };
  const sameApp = (row: Partial<NativeBuildRow> = {}): Ipa => ({
    row,
    devices: [PHONE, LATER_PHONE],
  });
  const newerUrl = `https://storage.example.com/${NEWER}.ipa`;

  it("offers a newer build of this app and channel whose IPA lists the device", async () => {
    const { result } = await check(sameApp());
    expect(result).toMatchObject({
      device: "not-included",
      newerBuild: NEWER,
    });
  });

  it("offers it when its export method predates being recorded, and its profile says ad hoc", async () => {
    const { result } = await check(sameApp({ export_method: null }));
    expect(result).toMatchObject({ newerBuild: NEWER });
  });

  it("two schemes on one registry: a production page never sends the iPhone to the sandbox build that listed it last", async () => {
    const { result, core, urls } = await check(
      sameApp({ is_sandbox: true, channel_id: "production" }),
    );
    expect(result).toMatchObject({ device: "not-included", newerBuild: null });
    // The sandbox build's row decides, without reading its IPA.
    expect(core.getNativeBuild).toHaveBeenCalledTimes(2);
    expect(urls).not.toContain(newerUrl);
  });

  describe("of a sandbox build, which pull requests reuse across channels", () => {
    const sandbox = {
      is_sandbox: true,
      scope_key:
        "v1:sandbox:ios:com.example.app:acme-preview:ipa:direct:fingerprint:fp",
    };

    it("offers a newer sandbox build of its scope that another pull request's channel embeds", async () => {
      const { result } = await check(
        sameApp({ ...sandbox, channel_id: "channel:pr-140" }),
        { ...sandbox, channel_id: "channel:pr-120" },
      );
      expect(result).toMatchObject({ newerBuild: NEWER });
    });

    it("offers nothing for a newer sandbox build of another scope, reading no IPA", async () => {
      const { result, urls } = await check(
        sameApp({
          ...sandbox,
          scope_key: sandbox.scope_key.replace(":fp", ":fp-other"),
        }),
        sandbox,
      );
      expect(result).toMatchObject({ newerBuild: null });
      expect(urls).not.toContain(newerUrl);
    });
  });

  it.each<[string, Partial<NativeBuildRow>]>([
    ["another channel", { channel_id: "staging" }],
    ["an App Store export", { export_method: "app-store" }],
    ["a development export", { export_method: "development" }],
    ["an APK", { platform: "android", artifact_kind: "apk" }],
  ])("offers nothing for %s, reading no IPA", async (_, row) => {
    const { result, urls } = await check(sameApp(row));
    expect(result).toMatchObject({ newerBuild: null });
    expect(urls).not.toContain(newerUrl);
  });

  it("offers nothing for another app on the same channel, which only its IPA tells apart", async () => {
    const { result, urls } = await check({
      ...sameApp(),
      bundleId: "com.example.app.staging",
    });
    expect(result).toMatchObject({ newerBuild: null });
    expect(urls).toContain(newerUrl);
  });

  it("offers nothing when the newer IPA doesn't list the device, or the build is gone", async () => {
    expect((await check({ row: {}, devices: [PHONE] })).result).toMatchObject({
      newerBuild: null,
    });
    expect((await check(null)).result).toMatchObject({ newerBuild: null });
  });
});

describe("readNativeBuildIpaDevices", () => {
  it("lists the IPA's devices, named by the registry's registered and approved devices", async () => {
    const bytes = await ipaBytes(adHocProfile([PHONE, LATER_PHONE]));
    const { fetch } = rangeServer(bytes);
    const core = coreOf(rowOf(bytes.length), [
      registryRow(PHONE, "Kim's iPhone"),
      registryRow("a".repeat(40), "Not in this IPA"),
    ]);
    expect(
      await readNativeBuildIpaDevices(
        BUILD,
        { core, storage: storageOf() },
        fetch,
      ),
    ).toEqual({
      status: "listed",
      devices: [
        { udid: PHONE.toLowerCase(), name: "Kim's iPhone" },
        { udid: LATER_PHONE.toLowerCase(), name: null },
      ].sort((a, b) => (a.udid < b.udid ? -1 : 1)),
    });
    expect(
      core.listIosDevices.mock.calls.map(([input]) => input?.status),
    ).toEqual(["registered", "approved"]);
    expect(core.findIosDevice).not.toHaveBeenCalled();
  });

  it("names the IPA's devices in as many reads however many devices the registry has", async () => {
    const bytes = await ipaBytes(adHocProfile([PHONE, LATER_PHONE]));
    /** The registry's reads, past `others` devices the IPA doesn't list. */
    const readsPast = async (others: number) => {
      const database = meterReads({
        name: "memory",
        adapter: createMemoryAdapter(),
      });
      const { core } = createHotUpdater({
        database,
        storage: { name: "none", protocol: "none" },
        plugins: [],
        clientAccess: "public",
      });
      const { device } = await core.requestIosDevice({
        udid: PHONE,
        name: "Kim's iPhone",
        requestedBy: null,
      });
      await core.approveIosDevice(device.id, { approvedBy: null });
      // Pending requests, which any signed-in user can add.
      for (let i = 1; i <= others; i += 1) {
        await core.requestIosDevice({
          udid: i.toString(16).padStart(40, "0"),
          name: "Not in this IPA",
          requestedBy: null,
        });
      }
      const { fetch } = rangeServer(bytes);
      const { result, adapter } = await database.measureReads(() =>
        readNativeBuildIpaDevices(
          BUILD,
          {
            core: { ...core, getNativeBuild: async () => rowOf(bytes.length) },
            storage: storageOf(),
          },
          fetch,
        ),
      );
      expect(result).toEqual({
        status: "listed",
        devices: [
          { udid: PHONE.toLowerCase(), name: "Kim's iPhone" },
          { udid: LATER_PHONE.toLowerCase(), name: null },
        ].sort((a, b) => (a.udid < b.udid ? -1 : 1)),
      });
      return adapter;
    };

    // More than a page of the registry at both sizes.
    expect(await readsPast(450)).toEqual(await readsPast(250));
  });

  it("names an IPA of 40 devices in as many registry requests as one of 2", async () => {
    /** The registry requests that name an IPA listing `count` approved devices. */
    const requestsFor = async (count: number) => {
      const udids = Array.from({ length: count }, (_, i) =>
        (i + 1).toString(16).padStart(40, "a"),
      );
      const bytes = await ipaBytes(adHocProfile(udids));
      const database = meterReads({
        name: "memory",
        adapter: createMemoryAdapter(),
      });
      const { core } = createHotUpdater({
        database,
        storage: { name: "none", protocol: "none" },
        plugins: [],
        clientAccess: "public",
      });
      for (const udid of udids) {
        const { device } = await core.requestIosDevice({
          udid,
          name: `Phone ${udid.slice(-2)}`,
          requestedBy: null,
        });
        await core.approveIosDevice(device.id, { approvedBy: null });
      }
      const { fetch } = rangeServer(bytes);
      const { result, adapter } = await database.measureReads(() =>
        readNativeBuildIpaDevices(
          BUILD,
          {
            core: { ...core, getNativeBuild: async () => rowOf(bytes.length) },
            storage: storageOf(),
          },
          fetch,
        ),
      );
      expect(result).toMatchObject({ status: "listed" });
      expect(
        (result as { devices: { name: string | null }[] }).devices.every(
          ({ name }) => name !== null,
        ),
      ).toBe(true);
      return adapter.gets + adapter.queries;
    };

    expect(await requestsFor(40)).toBe(await requestsFor(2));
  });

  it("is unavailable for a missing build, and reads no registry", async () => {
    const core = coreOf(null);
    expect(
      await readNativeBuildIpaDevices(BUILD, { core, storage: storageOf() }),
    ).toEqual({ status: "unavailable" });
    expect(core.listIosDevices).not.toHaveBeenCalled();
  });
});

describe("serveNativeBuildManifest", () => {
  const CONSOLE = "https://console.example.com";
  const manifestUrl = (token: string, id = BUILD, base = CONSOLE) =>
    `${base}/_hot-updater/native-builds/${id}/manifest.plist?t=${encodeURIComponent(token)}`;

  const serve = async (
    url: string,
    profile = adHocProfile([PHONE]),
    overrides: Partial<NativeBuildRow> = {},
  ) => {
    const bytes = await ipaBytes(profile);
    const { fetch, served } = rangeServer(bytes);
    const core = coreOf(rowOf(bytes.length, overrides));
    const loadDeps = vi.fn(async () => ({ core, storage: storageOf() }));
    const id = /native-builds\/([^/]+)\//u.exec(url)![1]!;
    const response = await serveNativeBuildManifest(
      new Request(url),
      id,
      loadDeps,
      fetch,
    );
    return { response, loadDeps, core, served };
  };

  /** A token signed with this Console's key for another purpose. */
  const wrongPurposeToken = async (expiresAtSeconds: number) => {
    const encoder = new TextEncoder();
    const hmac = async (key: BufferSource, message: string) =>
      new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          await crypto.subtle.importKey(
            "raw",
            key,
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"],
          ),
          encoder.encode(message),
        ),
      );
    const key = await hmac(
      encoder.encode(SECRET),
      "hot-updater/console/signed-links/v1",
    );
    const signature = btoa(
      String.fromCharCode(
        ...(await hmac(
          key,
          `native-build-collection\n${BUILD}\n${expiresAtSeconds}`,
        )),
      ),
    )
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    return `${expiresAtSeconds}.${signature}`;
  };

  it("control: the same token shape, signed for downloads, passes", async () => {
    const token = await createNativeBuildDownloadToken(
      SECRET,
      BUILD,
      Date.now() + 60_000,
    );
    const { response } = await serve(manifestUrl(token));
    expect(response.status).toBe(200);
  });

  it("refuses a forged, expired, other build's, wrong-purpose, or missing token before any read", async () => {
    const valid = await createNativeBuildDownloadToken(
      SECRET,
      BUILD,
      Date.now() + 60_000,
    );
    const future = Math.floor(Date.now() / 1000) + 60;
    const tokens = [
      `${valid.slice(0, -1)}${valid.endsWith("A") ? "B" : "A"}`,
      await createNativeBuildDownloadToken(SECRET, BUILD, Date.now() - 1_000),
      await createNativeBuildDownloadToken(
        SECRET,
        OTHER_BUILD,
        Date.now() + 60_000,
      ),
      await createNativeBuildDownloadToken(
        `${SECRET}-other`,
        BUILD,
        Date.now() + 60_000,
      ),
      await wrongPurposeToken(future),
      "",
      "not-a-token",
    ];
    for (const token of tokens) {
      const { response, loadDeps, served } = await serve(manifestUrl(token));
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
      if (token) expect(await response.text()).not.toContain(token);
      expect(loadDeps).not.toHaveBeenCalled();
      expect(served.requests).toBe(0);
    }
    const missing = await serve(
      `${CONSOLE}/_hot-updater/native-builds/${BUILD}/manifest.plist`,
    );
    expect(missing.response.status).toBe(403);
    expect(missing.loadDeps).not.toHaveBeenCalled();
  });

  it("refuses every token on a Console without its secret, before any read", async () => {
    const token = await createNativeBuildDownloadToken(
      SECRET,
      BUILD,
      Date.now() + 60_000,
    );
    vi.stubEnv(CONSOLE_SECRET_ENV, "");
    const { response, loadDeps } = await serve(manifestUrl(token));
    expect(response.status).toBe(403);
    expect(loadDeps).not.toHaveBeenCalled();
  });

  it("answers the token alone with a manifest that carries the same token and mints nothing, in one row read", async () => {
    const token = await createNativeBuildDownloadToken(
      SECRET,
      BUILD,
      Date.now() + 60_000,
    );
    const { response, core, served } = await serve(
      manifestUrl(token, BUILD, "https://example.com/console"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/xml; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("set-cookie")).toBeNull();
    const xml = await response.text();
    expect(xml).toContain(
      `<string>https://example.com/console/api/native-builds/${BUILD}/download?t=${encodeURIComponent(token)}</string>`,
    );
    expect(xml).toContain("<string>software-package</string>");
    expect(xml).toContain("<string>com.example.app</string>");
    expect(xml).toContain("<string>42</string>");
    expect(xml).toContain(
      "<string>Tom &amp; Jerry&apos;s &lt;App&gt;</string>",
    );
    expect(xml).not.toContain("secret-signature");
    expect(core.getNativeBuild).toHaveBeenCalledTimes(1);
    expect(served.requests).toBeLessThanOrEqual(4);
  });

  it.runIf(process.platform === "darwin")(
    "writes a manifest plutil reads",
    async () => {
      const token = await createNativeBuildDownloadToken(
        SECRET,
        BUILD,
        Date.now() + 60_000,
      );
      const { response } = await serve(manifestUrl(token));
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "manifest-"));
      try {
        const file = path.join(directory, "manifest.plist");
        await fs.writeFile(file, await response.text());
        const title = execFileSync(
          "plutil",
          ["-extract", "items.0.metadata.title", "raw", "-o", "-", file],
          { encoding: "utf8" },
        ).trim();
        expect(title).toBe("Tom & Jerry's <App>");
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("asks for HTTPS asset URLs behind a proxy that ends TLS", async () => {
    const token = await createNativeBuildDownloadToken(
      SECRET,
      BUILD,
      Date.now() + 60_000,
    );
    const bytes = await ipaBytes(adHocProfile([PHONE]));
    const { fetch } = rangeServer(bytes);
    const response = await serveNativeBuildManifest(
      new Request(manifestUrl(token, BUILD, "http://console.example.com"), {
        headers: { "x-forwarded-proto": "https" },
      }),
      BUILD,
      async () => ({ core: coreOf(rowOf(bytes.length)), storage: storageOf() }),
      fetch,
    );
    expect(await response.text()).toContain(
      `<string>https://console.example.com/api/native-builds/${BUILD}/download?t=`,
    );
  });

  it.each([
    ["an App Store export", mobileprovision(""), 409],
    ["an expired profile", adHocProfile([PHONE], "2020-01-01T00:00:00Z"), 409],
  ])("refuses %s", async (_, profile, status) => {
    const token = await createNativeBuildDownloadToken(
      SECRET,
      BUILD,
      Date.now() + 60_000,
    );
    const { response } = await serve(manifestUrl(token), profile);
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("<plist");
  });

  it("refuses a sandbox App Store export without TestFlight advice", async () => {
    const token = await createNativeBuildDownloadToken(
      SECRET,
      BUILD,
      Date.now() + 60_000,
    );
    const { response } = await serve(manifestUrl(token), mobileprovision(""), {
      is_sandbox: true,
    });
    expect(response.status).toBe(409);
    expect(await response.text()).toBe(
      "This IPA is an App Store export, which doesn't install from a link.",
    );
  });

  it("gives 404 for no build or another kind of artifact, and 503 when the IPA can't be read in parts", async () => {
    const token = await createNativeBuildDownloadToken(
      SECRET,
      BUILD,
      Date.now() + 60_000,
    );
    const request = new Request(manifestUrl(token));
    for (const row of [null, rowOf(100, { artifact_kind: "apk" })]) {
      const response = await serveNativeBuildManifest(
        request,
        BUILD,
        async () => ({
          core: coreOf(row),
          storage: storageOf(),
        }),
      );
      expect(response.status).toBe(404);
    }
    const unavailable = await serveNativeBuildManifest(
      request,
      BUILD,
      async () => ({ core: coreOf(rowOf(100)), storage: storageOf() }),
      vi.fn(async () => new Response("all of it")) as never,
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).toBe("Installation details unavailable.");
  });
});
