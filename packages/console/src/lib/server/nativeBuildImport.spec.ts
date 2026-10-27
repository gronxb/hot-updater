// @vitest-environment node

import { createStorageAdapter } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import {
  importNativeBuild,
  NativeBuildImportRefusal,
  resolveUpdateStrategy,
} from "./nativeBuildImport";

const FINGERPRINT = "a".repeat(64);

const registry = (newest: { fingerprint_hash: string | null } | undefined) => ({
  listNativeBuilds: vi.fn(async () => (newest === undefined ? [] : [newest])),
});

describe("resolveUpdateStrategy", () => {
  it("takes the configured strategy without reading the registry", async () => {
    const core = registry({ fingerprint_hash: FINGERPRINT });
    await expect(
      resolveUpdateStrategy(core as never, "appVersion", {
        fingerprintCandidates: [FINGERPRINT],
      }),
    ).resolves.toBe("appVersion");
    expect(core.listNativeBuilds).not.toHaveBeenCalled();
  });

  it("takes the newest registered build's, whatever the artifact holds", async () => {
    await expect(
      resolveUpdateStrategy(
        registry({ fingerprint_hash: null }) as never,
        undefined,
        { fingerprintCandidates: [FINGERPRINT] },
      ),
    ).resolves.toBe("appVersion");
    await expect(
      resolveUpdateStrategy(
        registry({ fingerprint_hash: FINGERPRINT }) as never,
        undefined,
        { fingerprintCandidates: [] },
      ),
    ).resolves.toBe("fingerprint");
  });

  it("with an empty registry, takes whether the artifact compiled a fingerprint in", async () => {
    const core = registry(undefined);
    await expect(
      resolveUpdateStrategy(core as never, undefined, {
        fingerprintCandidates: [FINGERPRINT],
      }),
    ).resolves.toBe("fingerprint");
    await expect(
      resolveUpdateStrategy(core as never, undefined, {
        fingerprintCandidates: [],
      }),
    ).resolves.toBe("appVersion");
  });
});

describe("importNativeBuild", () => {
  it("stops reading a body over the limit, and stores nothing", async () => {
    const put = vi.fn();
    const error = await importNativeBuild({
      body: new Blob([new Uint8Array(2048)]).stream(),
      fileName: "app.apk",
      core: {} as never,
      storage: createStorageAdapter({
        name: "s",
        protocol: "s",
        put,
        exists: vi.fn(),
      }),
      updateStrategy: undefined,
      maxBytes: 1024,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NativeBuildImportRefusal);
    expect((error as NativeBuildImportRefusal).status).toBe(413);
    expect(put).not.toHaveBeenCalled();
  });
});
