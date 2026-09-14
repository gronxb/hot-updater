import { describe, expect, it, vi } from "vitest";

import {
  captureCommandWithDeadline,
  captureArtifactSelectionEvidence,
  classifyArtifactSelection,
  classifyArtifactSelectionHistory,
  collectManifestDiffLogs,
  hasLynxFirstOtaArchiveEvidence,
  isExactLynxFirstOtaArchiveSelection,
} from "./manifest-diff-assertion.ts";

const archivePayload = {
  archiveByteSize: 900,
  fileHash: "archive-hash",
  fileUrl: "https://storage.example.com/archive.zip?signature=one",
};

const manifestPayload = {
  changedAssets: {
    "main.bundle": {
      file: null,
      fileHash: "main-target-hash",
      patch: {
        algorithm: "bsdiff",
        baseBundleId: "base-bundle",
        baseFileHash: "main-base-hash",
        byteSize: 120,
        patchFileHash: "main-patch-hash",
        patchUrl: "https://storage.example.com/main.patch?signature=one",
        targetFileHash: "main-target-hash",
      },
    },
    "metadata.json": {
      downloadByteSize: 80,
      downloadCompression: null,
      file: {
        byteSize: 70,
        compression: null,
        fileHash: "metadata-download-hash",
        url: "https://storage.example.com/metadata.json?signature=one",
      },
      fileHash: "metadata-target-hash",
      patch: null,
    },
  },
  fileHash: "archive-hash",
  fileUrl: "https://storage.example.com/archive.zip?signature=one",
  manifestFileHash: "manifest-hash",
  manifestUrl: "https://storage.example.com/manifest.json?signature=one",
  patchAssetPath: "main.bundle",
  selectionId: "selection-one",
};

function capture(payload: unknown) {
  const evidence = captureArtifactSelectionEvidence(payload);
  expect(evidence).not.toBeNull();
  return evidence!;
}

describe("manifest diff assertion", () => {
  it("skips reuse evidence only for a captured archive-only selection", () => {
    expect(classifyArtifactSelection(capture(archivePayload))).toBe(
      "archive-only",
    );
  });

  it("requires complete manifest-diff evidence before enabling strict reuse checks", () => {
    const manifestDiff = capture(manifestPayload);
    expect(classifyArtifactSelection(manifestDiff)).toBe("manifest-diff");
    for (const incompletePayload of [
      { ...manifestPayload, changedAssets: {} },
      { ...manifestPayload, changedAssets: null },
      { ...manifestPayload, manifestFileHash: null },
      { ...manifestPayload, manifestUrl: null },
    ]) {
      expect(classifyArtifactSelection(capture(incompletePayload))).toBeNull();
    }
  });

  it("rejects changed assets without a complete usable file or patch", () => {
    const invalidAssets = [
      { file: null, fileHash: "target-hash", patch: null },
      { file: {}, fileHash: "target-hash", patch: null },
      {
        file: null,
        fileHash: "target-hash",
        patch: {
          algorithm: "bsdiff",
          baseBundleId: "base-bundle",
          baseFileHash: "base-hash",
          patchUrl: "https://storage.example.com/asset.patch",
        },
      },
      {
        file: { url: "https://storage.example.com/asset" },
        patch: null,
      },
      {
        file: {},
        fileHash: "target-hash",
        patch: {
          algorithm: "bsdiff",
          baseBundleId: "base-bundle",
          baseFileHash: "base-hash",
          patchFileHash: "patch-hash",
          patchUrl: "https://storage.example.com/asset.patch",
        },
      },
    ];

    for (const asset of invalidAssets) {
      expect(
        classifyArtifactSelection(
          capture({
            changedAssets: { "asset.bin": asset },
            manifestFileHash: "manifest-hash",
            manifestUrl: "https://storage.example.com/manifest.json",
          }),
        ),
      ).toBeNull();
    }
  });

  it("requires every repeated capture to have one consistent classification", () => {
    const archiveOnly = capture(archivePayload);
    const manifestDiff = capture(manifestPayload);
    expect(classifyArtifactSelectionHistory([archiveOnly, archiveOnly])).toBe(
      "archive-only",
    );
    expect(classifyArtifactSelectionHistory([manifestDiff, manifestDiff])).toBe(
      "manifest-diff",
    );
    expect(
      classifyArtifactSelectionHistory([archiveOnly, manifestDiff]),
    ).toBeNull();
    expect(
      classifyArtifactSelectionHistory([manifestDiff, archiveOnly]),
    ).toBeNull();
  });

  it.each([
    ["manifest hash", (value: any) => (value.manifestFileHash = "other")],
    [
      "asset target hash",
      (value: any) => (value.changedAssets["metadata.json"].fileHash = "other"),
    ],
    [
      "asset compression",
      (value: any) =>
        (value.changedAssets["metadata.json"].downloadCompression = "br"),
    ],
    [
      "asset byte size",
      (value: any) =>
        (value.changedAssets["metadata.json"].downloadByteSize = 81),
    ],
    [
      "file hash",
      (value: any) =>
        (value.changedAssets["metadata.json"].file.fileHash = "other"),
    ],
    [
      "file compression",
      (value: any) =>
        (value.changedAssets["metadata.json"].file.compression = "br"),
    ],
    [
      "file byte size",
      (value: any) => (value.changedAssets["metadata.json"].file.byteSize = 71),
    ],
    [
      "patch hash",
      (value: any) =>
        (value.changedAssets["main.bundle"].patch.patchFileHash = "other"),
    ],
    [
      "patch algorithm",
      (value: any) =>
        (value.changedAssets["main.bundle"].patch.algorithm = "other"),
    ],
    [
      "patch base bundle",
      (value: any) =>
        (value.changedAssets["main.bundle"].patch.baseBundleId = "other"),
    ],
    [
      "patch byte size",
      (value: any) => (value.changedAssets["main.bundle"].patch.byteSize = 121),
    ],
    [
      "patch target hash",
      (value: any) =>
        (value.changedAssets["main.bundle"].patch.targetFileHash = "other"),
    ],
    ["patch asset path", (value: any) => (value.patchAssetPath = "other")],
    ["selection identity", (value: any) => (value.selectionId = "other")],
  ])(
    "rejects repeated manifest captures with a different %s",
    (_name, mutate) => {
      const changed = structuredClone(manifestPayload);
      mutate(changed);
      expect(
        classifyArtifactSelectionHistory([
          capture(manifestPayload),
          capture(changed),
        ]),
      ).toBeNull();
    },
  );

  it("rejects repeated archive captures with a different immutable hash", () => {
    expect(
      classifyArtifactSelectionHistory([
        capture(archivePayload),
        capture({ ...archivePayload, fileHash: "other-archive-hash" }),
      ]),
    ).toBeNull();
  });

  it("allows signed URL renewal when immutable selection fields are unchanged", () => {
    const renewed = structuredClone(manifestPayload);
    renewed.fileUrl = "https://other.example.com/archive?signature=two";
    renewed.manifestUrl = "https://other.example.com/manifest?signature=two";
    renewed.changedAssets["metadata.json"].file.url =
      "https://other.example.com/metadata?signature=two";
    renewed.changedAssets["main.bundle"].patch.patchUrl =
      "https://other.example.com/patch?signature=two";

    expect(
      classifyArtifactSelectionHistory([
        capture(manifestPayload),
        capture(renewed),
      ]),
    ).toBe("manifest-diff");
  });

  it("accepts only one exact immutable archive history for a first Lynx OTA", () => {
    const builtInBundleId = "00000000-0000-7000-8000-000000000000";
    const targetBundleId = "019f0000-0000-7000-8000-000000000001";
    const selection = {
      ...capture(archivePayload),
      currentBundleId: builtInBundleId,
      targetBundleId,
    };
    const renewed = {
      ...capture({
        ...archivePayload,
        fileUrl: "https://storage.example.com/archive.zip?signature=two",
      }),
      currentBundleId: builtInBundleId,
      targetBundleId,
    };

    expect(
      isExactLynxFirstOtaArchiveSelection({
        builtInBundleId,
        selections: [selection, renewed],
        targetBundleId,
      }),
    ).toBe(true);

    for (const selections of [
      [],
      [{ ...selection, currentBundleId: "wrong-current" }],
      [{ ...selection, targetBundleId: "wrong-target" }],
      [
        selection,
        {
          ...selection,
          ...capture({ ...archivePayload, fileHash: "changed-hash" }),
        },
      ],
      [
        selection,
        {
          ...capture(manifestPayload),
          currentBundleId: builtInBundleId,
          targetBundleId,
        },
      ],
    ]) {
      expect(
        isExactLynxFirstOtaArchiveSelection({
          builtInBundleId,
          selections,
          targetBundleId,
        }),
      ).toBe(false);
    }
  });

  it("requires pending native store proof for the exact Lynx archive target", () => {
    const builtInBundleId = "00000000-0000-7000-8000-000000000000";
    const targetBundleId = "019f0000-0000-7000-8000-000000000001";
    const selection = {
      ...capture(archivePayload),
      currentBundleId: builtInBundleId,
      targetBundleId,
    };
    const evidence = {
      builtInBundleId,
      bundleFileExists: true,
      selections: [selection],
      stableBundleId: null,
      stagingBundleId: targetBundleId,
      stagingSelectionBundleId: targetBundleId,
      targetBundleId,
      verificationPending: true,
    };

    expect(hasLynxFirstOtaArchiveEvidence(evidence)).toBe(true);
    expect(
      hasLynxFirstOtaArchiveEvidence({
        ...evidence,
        bundleFileExists: false,
      }),
    ).toBe(false);
    expect(
      hasLynxFirstOtaArchiveEvidence({
        ...evidence,
        stableBundleId: targetBundleId,
      }),
    ).toBe(false);
    expect(
      hasLynxFirstOtaArchiveEvidence({
        ...evidence,
        stagingBundleId: "wrong-target",
      }),
    ).toBe(false);
    expect(
      hasLynxFirstOtaArchiveEvidence({
        ...evidence,
        stagingSelectionBundleId: "wrong-target",
      }),
    ).toBe(false);
    expect(
      hasLynxFirstOtaArchiveEvidence({
        ...evidence,
        verificationPending: false,
      }),
    ).toBe(false);
  });

  it("normalizes object key order while preserving ordered selection fields", () => {
    const reordered = Object.fromEntries(
      Object.entries(manifestPayload).reverse(),
    );
    reordered.changedAssets = Object.fromEntries(
      Object.entries(manifestPayload.changedAssets).reverse(),
    );
    expect(
      classifyArtifactSelectionHistory([
        capture(manifestPayload),
        capture(reordered),
      ]),
    ).toBe("manifest-diff");

    const ordered = { ...manifestPayload, selectionOrder: ["file", "patch"] };
    expect(
      classifyArtifactSelectionHistory([
        capture(ordered),
        capture({ ...ordered, selectionOrder: ["patch", "file"] }),
      ]),
    ).toBeNull();
  });

  it("reuses one bounded iOS log snapshot for every manifest assertion check", async () => {
    const readIosLogs = vi.fn().mockResolvedValue("native events");
    const readAndroidArchiveLogs = vi.fn();
    const readAndroidBsdiffLogs = vi.fn();
    const readAndroidNativeLogs = vi.fn();

    await expect(
      collectManifestDiffLogs({
        platform: "ios",
        readAndroidArchiveLogs,
        readAndroidBsdiffLogs,
        readAndroidNativeLogs,
        readIosLogs,
      }),
    ).resolves.toEqual({
      archiveLogs: "native events",
      bsdiffLogs: "native events",
      nativeLogs: "native events",
    });
    expect(readIosLogs).toHaveBeenCalledOnce();
    expect(readAndroidArchiveLogs).not.toHaveBeenCalled();
    expect(readAndroidBsdiffLogs).not.toHaveBeenCalled();
    expect(readAndroidNativeLogs).not.toHaveBeenCalled();
  });

  it("terminates a stalled log command on its deadline or request abort", async () => {
    const stalledCommand = ["-e", "setInterval(() => {}, 1000)"];
    await expect(
      captureCommandWithDeadline(process.execPath, stalledCommand, {
        timeoutMs: 50,
      }),
    ).rejects.toThrow("timed out after 50ms");

    const controller = new AbortController();
    const reason = new Error("request ended");
    const capture = captureCommandWithDeadline(
      process.execPath,
      stalledCommand,
      { signal: controller.signal, timeoutMs: 10_000 },
    );
    controller.abort(reason);
    await expect(capture).rejects.toBe(reason);
  });
});
