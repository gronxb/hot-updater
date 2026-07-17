import { S3Client } from "@aws-sdk/client-s3";
import {
  databaseAnalyticsSupport,
  databaseBundleEventService,
} from "@hot-updater/plugin-core";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { s3Database } from "./s3Database";

const s3Mock = mockClient(S3Client);

beforeEach(() => s3Mock.reset());

describe("S3 active installation Analytics capability", () => {
  it("exposes no Analytics service and sends no S3 request", () => {
    const adapter = s3Database({ bucketName: "analytics-disabled" });

    expect(Reflect.get(adapter, databaseAnalyticsSupport)).toBeUndefined();
    expect(Reflect.get(adapter, databaseBundleEventService)).toBeUndefined();
    expect(s3Mock.calls()).toHaveLength(0);
  });
});
