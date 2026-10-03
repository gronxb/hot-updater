import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { isUUIDv7 } from "@hot-updater/protocol";
import { createHotUpdater } from "@hot-updater/server";
import { standaloneRepository } from "@hot-updater/standalone";

const run = promisify(execFile);
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
  const database = standaloneRepository({
    baseUrl: `${origin}/hot-updater/admin`,
    commonHeaders: { authorization: `Bearer ${token}` },
  });
  const server = createHotUpdater({ database, clientAccess: "public" });
  const target = await server.core.getBundle(targetBundleId);
  assert.ok(
    target,
    "The target Bundle must be deployed before patch generation",
  );
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lynx-matrix-patch-"));
  try {
    await fs.writeFile(
      path.join(cwd, "package.json"),
      '{"private":true,"type":"module"}\n',
    );
    await fs.writeFile(
      path.join(cwd, "hot-updater.config.mjs"),
      `
import { standaloneRepository, standaloneStorage } from ${JSON.stringify(import.meta.resolve("@hot-updater/standalone"))};
const commonHeaders = { authorization: "Bearer " + process.env.LYNX_MATRIX_ADMIN_TOKEN };
export default {
  database: standaloneRepository({ baseUrl: ${JSON.stringify(`${origin}/hot-updater/admin`)}, commonHeaders }),
  storage: standaloneStorage({ baseUrl: ${JSON.stringify(`${origin}/storage`)}, commonHeaders, protocol: "lynx-local" }),
};
`,
    );
    const cliPackage = fileURLToPath(
      import.meta.resolve("hot-updater/package.json"),
    );
    const { bin } = JSON.parse(await fs.readFile(cliPackage, "utf8"));
    await run(
      process.execPath,
      [
        path.resolve(path.dirname(cliPackage), bin["hot-updater"]),
        "patch",
        "--artifact-id",
        targetBundleId,
        "--base-artifact-id",
        baseBundleId,
        "--platform",
        target.bundle.platform,
        "--no-interactive",
      ],
      {
        cwd,
        env: { ...process.env, LYNX_MATRIX_ADMIN_TOKEN: token },
        maxBuffer: 8 * 1024 * 1024,
      },
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
    await database.dispose?.();
  }
  const deliveryArtifactUrl = `${origin}/hot-updater/artifacts/v1/${targetBundleId}/from/${baseBundleId}`;
  const response = await fetch(deliveryArtifactUrl);
  assert.equal(
    response.status,
    200,
    `Reverse delta artifact request failed: ${deliveryArtifactUrl}`,
  );
  const deliveryArtifactResponse = await response.json();
  assert.equal(deliveryArtifactResponse.artifactProtocolVersion, 1);
  assert.ok(
    Object.values(deliveryArtifactResponse.assets).some(
      (asset) => asset.patch?.baseBundleId === baseBundleId,
    ),
  );
  return {
    baseBundleId,
    bundleId: targetBundleId,
    deliveryArtifactResponse,
    deliveryArtifactUrl,
    releaseId,
  };
}
