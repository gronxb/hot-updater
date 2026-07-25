import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { transformEnv } from "@hot-updater/cli-tools";
import { describe, expect, it } from "vitest";

const managedHandlerPath = path.resolve(
  import.meta.dirname,
  "../dist/lambda/index.cjs",
);

describe("AWS Lambda managed handler bundle", () => {
  it("contains no unresolved first-party internal runtime imports", async () => {
    // Given
    const source = await readFile(managedHandlerPath, "utf8");

    // When
    const unresolvedInternalImport =
      /require\(["'](?:@better-auth\/[^"']+|better-auth|@hot-updater\/(?:better-auth|plugin-core|server)(?:\/.*)?)["']\)/;

    // Then
    expect(source).not.toMatch(unresolvedInternalImport);
  });

  it("ships every relative CommonJS chunk referenced by the handler", async () => {
    // Given
    const source = await readFile(managedHandlerPath, "utf8");
    const relativeChunks = [
      ...source.matchAll(/require\(["'](\.\/[^"']+\.cjs)["']\)/gu),
    ].flatMap((match) => {
      const relativeChunk = match[1];
      return relativeChunk === undefined ? [] : [relativeChunk];
    });

    // When / Then
    expect(relativeChunks.length).toBeGreaterThan(0);
    await Promise.all(
      relativeChunks.map((relativeChunk) =>
        access(path.resolve(path.dirname(managedHandlerPath), relativeChunk)),
      ),
    );
  });

  it("injects only the API-key digest into the deployable artifact", async () => {
    // Given: provisioning produced separate raw-key and digest values.
    const rawApiKey = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const apiKeySha256 = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

    // When: IAC generates the Lambda artifact.
    const artifact = transformEnv(managedHandlerPath, {
      API_KEY_SHA256: apiKeySha256,
      CLOUDFRONT_KEY_PAIR_ID: "KTEST",
      S3_BUCKET_NAME: "hot-updater-test",
      SSM_PARAMETER_NAME: "/hot-updater/test",
      SSM_REGION: "us-east-1",
    });

    // Then: deployment contains the verifier but never the extractable key.
    expect(artifact).toContain(apiKeySha256);
    expect(artifact).not.toContain(rawApiKey);
  });
});
