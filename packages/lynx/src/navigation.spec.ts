import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeCall = vi.fn();

import {
  close,
  navigate,
  SPARKLING_NAVIGATION_LIMITS,
  SPARKLING_NAVIGATION_PROVENANCE,
} from "./navigation";

describe("managed Sparkling navigation", () => {
  beforeEach(() => {
    nativeCall.mockReset();
    nativeCall.mockImplementation(
      (
        _method: string,
        _request: unknown,
        callback: (value: unknown) => void,
      ) => callback({ code: 1, msg: "ok" }),
    );
    Object.assign(globalThis, {
      NativeModules: { spkPipe: { call: nativeCall } },
      lynx: { __globalProps: { containerID: "managed-source" } },
    });
  });

  it("delegates a canonical page and query to the locked upstream grammar", () => {
    const callback = vi.fn();
    navigate(
      {
        path: "pages/detail-v2.lynx.bundle",
        options: {
          animated: true,
          params: { title: "Second Page", value: "a+b" },
        },
      },
      callback,
    );

    expect(nativeCall).toHaveBeenCalledWith(
      "router.open",
      {
        containerID: "managed-source",
        protocolVersion: "1.0.0",
        data: {
          scheme:
            "hybrid://lynxview_page?bundle=pages%2Fdetail-v2.lynx.bundle&title=Second+Page&value=a%2Bb",
          animated: true,
        },
      },
      expect.any(Function),
    );
    expect(callback).toHaveBeenCalledWith({ code: 1, msg: "ok" });
  });

  it.each([
    " detail.lynx.bundle",
    "detail.lynx.bundle ",
    "./detail.lynx.bundle",
    "/detail.lynx.bundle",
    "Detail.lynx.bundle",
    "détail.lynx.bundle",
    "detail%2fchild.lynx.bundle",
    "detail.bundle",
  ])("rejects path alias %j before calling upstream", (pageEntry) => {
    const callback = vi.fn();
    navigate({ path: pageEntry }, callback);
    expect(nativeCall).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({
      code: -1,
      msg: "Invalid params: path must be a canonical page entry",
    });
  });

  it.each([
    { baseScheme: "https://example.com" },
    { directURL: "https://example.com" },
    { options: { replace: true } },
    { options: { replaceType: "alwaysCloseBeforeOpen" } },
    { options: { useSysBrowser: true } },
    { options: { interceptor: "other" } },
    { options: { extra: {} } },
    { options: { unknown: false } },
  ])("rejects an unmanaged option %# before calling upstream", (extra) => {
    const callback = vi.fn();
    navigate({ path: "detail.lynx.bundle", ...extra } as never, callback);
    expect(nativeCall).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ code: -1 }),
    );
  });

  it.each([
    "bundle",
    "url",
    "baseScheme",
    "replace",
    "replaceType",
    "useSysBrowser",
    "animated",
    "interceptor",
    "extra",
  ])("rejects reserved query key %s before calling upstream", (key) => {
    const callback = vi.fn();
    navigate(
      {
        path: "detail.lynx.bundle",
        options: { params: { [key]: "smuggled" } },
      },
      callback,
    );
    expect(nativeCall).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({
      code: -1,
      msg: `Invalid params: reserved navigation key ${key}`,
    });
  });

  it("enforces the custom parameter count before calling upstream", () => {
    const callback = vi.fn();
    const params = Object.fromEntries(
      Array.from(
        { length: SPARKLING_NAVIGATION_LIMITS.customParams },
        (_, i) => [`p${i}`, i],
      ),
    );
    navigate({ path: "detail.lynx.bundle", options: { params } }, callback);
    expect(nativeCall).toHaveBeenCalledOnce();

    nativeCall.mockClear();
    callback.mockClear();
    navigate(
      {
        path: "detail.lynx.bundle",
        options: { params: { ...params, overflow: true } },
      },
      callback,
    );
    expect(nativeCall).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({
      code: -1,
      msg: "Invalid params: too many navigation params",
    });
  });

  it("enforces decoded UTF-8 key bytes before calling upstream", () => {
    const callback = vi.fn();
    navigate(
      {
        path: "detail.lynx.bundle",
        options: { params: { ["é".repeat(64)]: "ok" } },
      },
      callback,
    );
    expect(nativeCall).toHaveBeenCalledOnce();

    nativeCall.mockClear();
    callback.mockClear();
    navigate(
      {
        path: "detail.lynx.bundle",
        options: { params: { [`${"é".repeat(64)}a`]: "too-large" } },
      },
      callback,
    );
    expect(nativeCall).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({
      code: -1,
      msg: "Invalid params: navigation key is too large",
    });
  });

  it("enforces decoded UTF-8 value bytes before calling upstream", () => {
    const callback = vi.fn();
    navigate(
      {
        path: "detail.lynx.bundle",
        options: { params: { value: "é".repeat(512) } },
      },
      callback,
    );
    expect(nativeCall).toHaveBeenCalledOnce();

    nativeCall.mockClear();
    callback.mockClear();
    navigate(
      {
        path: "detail.lynx.bundle",
        options: { params: { value: `${"é".repeat(512)}a` } },
      },
      callback,
    );
    expect(nativeCall).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({
      code: -1,
      msg: "Invalid params: navigation value is too large",
    });
  });

  it("applies the decoded value bound to the required bundle", () => {
    const callback = vi.fn();
    navigate({ path: `${"a".repeat(1_012)}.lynx.bundle` }, callback);
    expect(nativeCall).toHaveBeenCalledOnce();

    nativeCall.mockClear();
    callback.mockClear();
    navigate({ path: `${"a".repeat(1_013)}.lynx.bundle` }, callback);
    expect(nativeCall).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({
      code: -1,
      msg: "Invalid params: navigation value is too large",
    });
  });

  it("counts bundle and custom decoded bytes in the aggregate bound", () => {
    const callback = vi.fn();
    navigate(
      {
        path: "detail.lynx.bundle",
        options: { params: { a: "a".repeat(1_024), b: "b".repeat(998) } },
      },
      callback,
    );
    expect(nativeCall).toHaveBeenCalledOnce();

    nativeCall.mockClear();
    callback.mockClear();
    navigate(
      {
        path: "detail.lynx.bundle",
        options: { params: { a: "a".repeat(1_024), b: "b".repeat(999) } },
      },
      callback,
    );
    expect(nativeCall).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({
      code: -1,
      msg: "Invalid params: decoded navigation query is too large",
    });
  });

  it("enforces the encoded raw route UTF-8 bound", () => {
    const callback = vi.fn();
    navigate(
      {
        path: "detail.lynx.bundle",
        options: {
          params: { a: "é".repeat(512), b: "b".repeat(970) },
        },
      },
      callback,
    );
    const acceptedRoute = nativeCall.mock.calls[0]?.[1]?.data?.scheme;
    expect(Buffer.byteLength(acceptedRoute)).toBe(
      SPARKLING_NAVIGATION_LIMITS.rawRouteUtf8Bytes,
    );

    nativeCall.mockClear();
    callback.mockClear();
    navigate(
      {
        path: "detail.lynx.bundle",
        options: {
          params: { a: "é".repeat(512), b: "b".repeat(971) },
        },
      },
      callback,
    );
    expect(nativeCall).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({
      code: -1,
      msg: "Invalid params: navigation route is too large",
    });
  });

  it("delegates close with only the managed close surface", () => {
    const callback = vi.fn();
    close({ containerID: "managed-source", animated: true }, callback);
    expect(nativeCall).toHaveBeenCalledWith(
      "router.close",
      {
        containerID: "managed-source",
        protocolVersion: "1.0.0",
        data: { containerID: "managed-source", animated: true },
      },
      expect.any(Function),
    );
    expect(callback).toHaveBeenCalledWith({ code: 1, msg: "ok" });
  });

  it.each([
    { containerID: "" },
    { containerID: 1 },
    { animated: "yes" },
    { replace: false },
  ])("rejects invalid close input %# before calling upstream", (request) => {
    const callback = vi.fn();
    close(request as never, callback);
    expect(nativeCall).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({
      code: -1,
      msg: "Invalid params: unsupported managed close option",
    });
  });

  it("rejects a close target different from the source container", () => {
    const callback = vi.fn();
    close({ containerID: "different-page" }, callback);
    expect(nativeCall).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({
      code: -1,
      msg: "Invalid params: containerID must match the source page",
    });
  });
});

describe("Sparkling navigation provenance", () => {
  it("pins and tests the actual npm tarball source used by the example", () => {
    const require = createRequire(import.meta.url);
    const packageRoot = path.dirname(
      require.resolve("sparkling-navigation/package.json"),
    );
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    ) as { version: string };
    const navigateSource = fs.readFileSync(
      path.join(packageRoot, "src/navigate/navigate.ts"),
    );
    expect(packageJson.version).toBe(
      SPARKLING_NAVIGATION_PROVENANCE.packageVersion,
    );
    expect(createHash("sha256").update(navigateSource).digest("hex")).toBe(
      SPARKLING_NAVIGATION_PROVENANCE.navigateSourceSha256,
    );

    const lockfile = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../../pnpm-lock.yaml"),
      "utf8",
    );
    expect(lockfile).toContain(
      `sparkling-navigation@${SPARKLING_NAVIGATION_PROVENANCE.packageVersion}:\n    resolution: {integrity: ${SPARKLING_NAVIGATION_PROVENANCE.npmIntegrity}}`,
    );

    const prd = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../../plans/lynx-support/prd.md"),
      "utf8",
    );
    for (const identifier of Object.values(SPARKLING_NAVIGATION_PROVENANCE)) {
      expect(prd).toContain(identifier);
    }
  });
});
