import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";

export const MISSING_ASSET_RESPONSE_BODY = "Not found";
export const MISSING_ASSET_RESPONSE_SHA256 = crypto
  .createHash("sha256")
  .update(MISSING_ASSET_RESPONSE_BODY)
  .digest("hex");

const expectedFailures = {
  ios: {
    corrupt: {
      code: "FILE_HASH_MISMATCH",
      message: "File hash verification failed",
    },
    missing: {
      code: "NATIVE_ERROR",
      message: "Artifact download HTTP status rejected",
    },
  },
  android: {
    corrupt: {
      code: "NATIVE_ERROR",
      message: "Managed asset hash mismatch",
    },
    missing: {
      code: "NATIVE_ERROR",
      message: "Artifact HTTP status 404",
    },
  },
};

export function expectedRawDetailNativeFailure(platform, mode) {
  const expected = expectedFailures[platform]?.[mode];
  if (!expected)
    throw new Error(`Unknown raw-detail failure ${platform}/${mode}`);
  return expected;
}

export function validateSdkInstallFailure(value) {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.code !== "string" ||
    typeof value.message !== "string" ||
    typeof value.bundleId !== "string" ||
    (value.releaseId !== null && typeof value.releaseId !== "string")
  ) {
    throw new Error("Invalid SDK install failure observation");
  }
  return value;
}

export async function appendSdkInstallFailureEvidence(file, value) {
  const failure = validateSdkInstallFailure(value);
  const record = {
    receivedAt: new Date().toISOString(),
    transport: "matrix-control-http",
    failure,
  };
  await fsp.appendFile(file, `${JSON.stringify(record)}\n`);
  return record;
}

export function readSdkInstallFailureEvidence(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        throw new Error("Malformed persisted SDK install failure evidence");
      }
      if (
        !record ||
        typeof record !== "object" ||
        record.transport !== "matrix-control-http" ||
        typeof record.receivedAt !== "string" ||
        !Number.isFinite(Date.parse(record.receivedAt))
      ) {
        throw new Error("Invalid persisted SDK install failure evidence");
      }
      validateSdkInstallFailure(record.failure);
      return record;
    });
}
