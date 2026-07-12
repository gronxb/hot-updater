import type { Bundle } from "@hot-updater/core";

import type { BundleChangeSetV2 } from "./bundles";

export const IN_MEMORY_TEST_IDS = {
  first: "018f12ab-1234-7abc-8def-000000000001",
  second: "018f12ab-1234-7abc-8def-000000000002",
  third: "018f12ab-1234-7abc-8def-000000000003",
  fourth: "018f12ab-1234-7abc-8def-000000000004",
} as const;

export const IN_MEMORY_TEST_SCOPE = {
  tenantId: "tenant-alpha",
  principalId: "principal-alpha",
  context: undefined,
} as const;

export const createInMemoryTestBundle = (
  id: string,
  channel = "production",
): Bundle => ({
  id,
  platform: "ios",
  shouldForceUpdate: false,
  enabled: true,
  fileHash: `hash-${id}`,
  gitCommitHash: null,
  message: `bundle-${id}`,
  channel,
  storageUri: `memory://${id}`,
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
  metadata: { app_version: "1.0.0" },
});

export const createInMemoryPutChangeSet = (
  id: string,
  values: readonly Bundle[],
): BundleChangeSetV2 => ({
  id,
  changes: values.map((value) => ({
    type: "put",
    value,
    precondition: { state: "absent" },
  })),
});

export const createInMemoryDeleteChangeSet = (
  id: string,
  bundleId: string,
  revision: string,
): BundleChangeSetV2 => ({
  id,
  changes: [
    {
      type: "delete",
      id: bundleId,
      precondition: { state: "revision", revision },
    },
  ],
});

export const expectInvalidInMemoryCursor = async (
  operation: () => Promise<unknown>,
): Promise<void> => {
  const { expect } = await import("vitest");
  await expect(operation()).rejects.toMatchObject({ code: "INVALID_CURSOR" });
};
