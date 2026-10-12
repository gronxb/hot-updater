import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { verifyMatrixMixedTransfer } from "./public-matrix/mixed-transfer.mjs";

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function fixture({ archiveByteSize = 400_000, unchangedDetail = false } = {}) {
  const asset = (name: string, size: number) => ({
    fileHash: sha256(name),
    byteSize: size,
    downloadByteSize: size,
  });
  const base = {
    bundleId: "00000000-0000-7000-8000-000000000000",
    assets: {
      "main.lynx.bundle": asset("main-A", 200_000),
      "detail.lynx.bundle": asset("detail-A", 287_810),
      "assets/probe.ttf": asset("stable-font", 324_820),
      "hot-updater-lynx.json": asset("metadata-A", 4_478),
    },
  };
  const target = {
    bundleId: "00000000-0000-7000-8000-000000000001",
    assets: {
      ...base.assets,
      "main.lynx.bundle": asset("main-B", 200_000),
      "detail.lynx.bundle": asset(
        unchangedDetail ? "detail-A" : "detail-B",
        287_810,
      ),
      "hot-updater-lynx.json": asset("metadata-B", 4_478),
    },
    archive: { downloadByteSize: archiveByteSize },
  };
  const patch = {
    algorithm: "bsdiff",
    baseBundleId: base.bundleId,
    baseFileHash: base.assets["main.lynx.bundle"].fileHash,
    byteSize: 597,
  };
  const responses = new Map<string, string>();
  const deployment = (manifest: typeof base) => {
    const bytes = JSON.stringify(manifest);
    const manifestUrl = `https://matrix.test/${manifest.bundleId}/manifest.json`;
    responses.set(manifestUrl, bytes);
    const artifact = {
      manifestUrl,
      manifestFileHash: sha256(bytes),
      archiveUrl: `https://matrix.test/${manifest.bundleId}/bundle.tar.br`,
      assets: Object.fromEntries(
        Object.entries(manifest.assets).map(([path, entry]) => [
          path,
          {
            fileHash: entry.fileHash,
            file: { url: `https://matrix.test/${entry.fileHash}` },
            ...(path === "main.lynx.bundle" ? { patch } : {}),
          },
        ]),
      ),
    };
    return {
      bundleId: manifest.bundleId,
      persistedManifestFileHash: sha256(bytes),
      files: { "manifest.json": { sha256: sha256(bytes) } },
      artifactResponse: artifact,
      deliveryArtifactResponse: artifact,
    };
  };
  const a = deployment(base);
  const b = deployment(target);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => new Response(responses.get(url))),
  );
  return { a, b, patch, responses };
}

afterEach(() => vi.unstubAllGlobals());

describe("matrix mixed-transfer preflight", () => {
  it("accounts for raw detail, a usable main patch and byte-identical reuse", async () => {
    const { a, b } = fixture();
    const result = await verifyMatrixMixedTransfer(a, b);
    expect(result.mixedByteSize).toBe(292_885);
    expect(result.transfers).toContainEqual({
      path: "assets/probe.ttf",
      kind: "reuse",
      bytes: 0,
    });
    expect(result.transfers).toContainEqual({
      path: "main.lynx.bundle",
      kind: "patch",
      bytes: 597,
    });
    expect(result.transfers).toContainEqual({
      path: "detail.lynx.bundle",
      kind: "file",
      bytes: 287_810,
    });
  });

  it.each([272_223, 292_885])(
    "rejects a cheaper or equal archive (%i bytes)",
    async (archiveBytes) => {
      const { a, b } = fixture({ archiveByteSize: archiveBytes });
      await expect(verifyMatrixMixedTransfer(a, b)).rejects.toThrow(
        "must be cheaper than the archive",
      );
    },
  );

  it.each(["baseBundleId", "baseFileHash"] as const)(
    "rejects a main patch with the wrong %s",
    async (field) => {
      const { a, b, patch } = fixture();
      patch[field] = sha256("wrong-base");
      await expect(verifyMatrixMixedTransfer(a, b)).rejects.toThrow();
    },
  );

  it("rejects a manifest changed after verified deployment", async () => {
    const { a, b, responses } = fixture();
    const url = b.artifactResponse.manifestUrl;
    responses.set(url, responses.get(url)!.replace("400000", "900000"));
    await expect(verifyMatrixMixedTransfer(a, b)).rejects.toThrow(
      "differs from the verified deployment",
    );
  });

  it("rejects unchanged detail that would never be requested", async () => {
    const { a, b } = fixture({ unchangedDetail: true });
    await expect(verifyMatrixMixedTransfer(a, b)).rejects.toThrow(
      "Detail must change to exercise raw-file rejection",
    );
  });
});
