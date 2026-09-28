import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isUUIDv7 } from "../../../../packages/core/dist/index.mjs";
import { createBundleDiff } from "../../../../packages/server/dist/db/index.mjs";
import {
  standaloneRepository,
  standaloneStorage,
} from "../../../../plugins/standalone/dist/index.mjs";

const example = fileURLToPath(new URL("../../", import.meta.url));

export async function createPublicMatrixBundleDiff({
  baseBundleId,
  origin = "http://127.0.0.1:18791",
  releaseId,
  targetBundleId,
  tokenPath = path.join(example, ".hot-updater/ota/admin-token"),
}) {
  assert.ok(isUUIDv7(baseBundleId), "The base Bundle ID must be UUIDv7");
  assert.ok(isUUIDv7(targetBundleId), "The target Bundle ID must be UUIDv7");
  assert.equal(typeof releaseId, "string");
  assert.ok(releaseId.length > 0);
  const token = (await fs.readFile(tokenPath, "utf8")).trim();
  assert.ok(token.length > 0, "The matrix OTA admin token is empty");
  const commonHeaders = { authorization: `Bearer ${token}` };
  const databasePlugin = standaloneRepository({
    baseUrl: `${origin}/hot-updater/admin`,
    commonHeaders,
  });
  const storagePlugin = standaloneStorage({
    baseUrl: `${origin}/storage`,
    commonHeaders,
    protocol: "lynx-local",
  });
  await createBundleDiff(
    { baseBundleId, bundleId: targetBundleId },
    { databasePlugin, storagePlugin },
    { makePrimary: true },
  );
  const deliveryArtifactUrl = `${origin}/hot-updater/artifacts/${targetBundleId}/from/${baseBundleId}`;
  const response = await fetch(deliveryArtifactUrl);
  assert.equal(
    response.status,
    200,
    `Reverse delta artifact request failed: ${deliveryArtifactUrl}`,
  );
  const deliveryArtifactResponse = await response.json();
  assert.equal(deliveryArtifactResponse.fileUrl, null);
  assert.equal(deliveryArtifactResponse.fileHash, null);
  return {
    baseBundleId,
    bundleId: targetBundleId,
    deliveryArtifactResponse,
    deliveryArtifactUrl,
    releaseId,
  };
}
