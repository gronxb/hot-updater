import { S3Client } from "@aws-sdk/client-s3";
import { getCapabilityContributions } from "@hot-updater/plugin-core/internal/capabilities";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { s3Database } from "./s3Database";

const s3Mock = mockClient(S3Client);

beforeEach(() => s3Mock.reset());

describe("S3 Analytics provider capability", () => {
  it("contributes no provider and sends no S3 request", () => {
    const plugin = s3Database({ bucketName: "analytics-disabled" });

    expect(getCapabilityContributions(plugin)).toEqual([]);
    expect(s3Mock.calls()).toHaveLength(0);
  });
});
