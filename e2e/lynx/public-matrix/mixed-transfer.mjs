import assert from "node:assert/strict";
import { createHash } from "node:crypto";

async function readManifest(deployment, delivery) {
  assert.equal(delivery.manifestFileHash, deployment.persistedManifestFileHash);
  const response = await fetch(delivery.manifestUrl);
  assert.equal(
    response.status,
    200,
    "Published matrix manifest is unavailable",
  );
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    deployment.files["manifest.json"].sha256,
    "Published matrix manifest differs from the verified deployment",
  );
  const manifest = JSON.parse(bytes.toString("utf8"));
  assert.equal(manifest.bundleId, deployment.bundleId);
  return manifest;
}

const byteSize = (value) => {
  assert.ok(Number.isSafeInteger(value) && value > 0, "Missing transfer size");
  return value;
};

// Keep the optional archive available. The mixed-transfer rejection scenarios
// are valid only when the native planner would prefer main BSDIFF + raw detail.
export async function verifyMatrixMixedTransfer(
  baseDeployment,
  targetDeployment,
  delivery = targetDeployment.deliveryArtifactResponse,
) {
  const [base, target] = await Promise.all([
    readManifest(baseDeployment, baseDeployment.artifactResponse),
    readManifest(targetDeployment, delivery),
  ]);
  assert.ok(delivery.archiveUrl, "The complete archive must remain available");
  assert.deepEqual(
    Object.keys(delivery.assets).sort(),
    Object.keys(target.assets).sort(),
  );
  const main = delivery.assets["main.lynx.bundle"];
  const detail = delivery.assets["detail.lynx.bundle"];
  assert.equal(main.patch?.algorithm, "bsdiff");
  assert.equal(main.patch.baseBundleId, base.bundleId);
  assert.notEqual(
    main.fileHash,
    base.assets["main.lynx.bundle"].fileHash,
    "Main must change to exercise BSDIFF",
  );
  assert.equal(
    main.patch.baseFileHash,
    base.assets["main.lynx.bundle"].fileHash,
  );
  assert.ok(
    byteSize(main.patch.byteSize) <
      byteSize(target.assets["main.lynx.bundle"].downloadByteSize),
  );
  assert.notEqual(
    detail.fileHash,
    base.assets["detail.lynx.bundle"].fileHash,
    "Detail must change to exercise raw-file rejection",
  );
  assert.equal(
    detail.patch,
    undefined,
    "Detail must be fetched as a complete file",
  );
  assert.equal(
    detail.file?.compression ?? null,
    null,
    "Detail must remain raw",
  );

  const transfers = Object.entries(target.assets).map(([path, asset]) => {
    const descriptor = delivery.assets[path];
    assert.equal(descriptor.fileHash, asset.fileHash);
    assert.equal(
      descriptor.file?.compression ?? null,
      asset.downloadCompression ?? null,
    );
    byteSize(asset.byteSize);
    const originalBytes = byteSize(asset.downloadByteSize);
    if (base.assets[path]?.fileHash === asset.fileHash) {
      return { path, kind: "reuse", bytes: 0 };
    }
    const patch = descriptor.patch;
    if (
      patch?.algorithm === "bsdiff" &&
      patch.baseBundleId === base.bundleId &&
      patch.baseFileHash === base.assets[path]?.fileHash &&
      byteSize(patch.byteSize) < originalBytes
    ) {
      return { path, kind: "patch", bytes: patch.byteSize };
    }
    assert.ok(descriptor.file?.url, `Missing original file for ${path}`);
    return { path, kind: "file", bytes: originalBytes };
  });
  // Include sidecar transfer even though checkForUpdate may already cache it.
  const mixedByteSize = transfers.reduce(
    (sum, transfer) => sum + transfer.bytes,
    0,
  );
  const archiveByteSize = byteSize(target.archive?.downloadByteSize);
  assert.ok(
    mixedByteSize < archiveByteSize,
    `Mixed matrix transfer (${mixedByteSize} bytes) must be cheaper than the archive (${archiveByteSize} bytes)`,
  );
  return {
    baseBundleId: base.bundleId,
    targetBundleId: target.bundleId,
    mixedByteSize,
    archiveByteSize,
    transfers,
  };
}
