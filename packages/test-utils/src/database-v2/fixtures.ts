import type { Bundle } from "@hot-updater/core";

import type {
  DatabaseConnectorV2TestChangeSet,
  DatabaseConnectorV2TestScope,
} from "./types";

export const DATABASE_V2_SCOPE_ALPHA = {
  tenantId: "tenant-alpha",
  principalId: "principal-alpha",
  context: { marker: "alpha" },
} as const satisfies DatabaseConnectorV2TestScope;

export const DATABASE_V2_SCOPE_BETA = {
  tenantId: "tenant-alpha",
  principalId: "principal-beta",
  context: { marker: "beta" },
} as const satisfies DatabaseConnectorV2TestScope;

export const DATABASE_V2_SCOPE_OTHER_TENANT = {
  tenantId: "tenant-other",
  principalId: "principal-alpha",
  context: { marker: "other" },
} as const satisfies DatabaseConnectorV2TestScope;

export function createDatabaseV2TestBundle(
  id: string,
  channel: string,
): Bundle {
  return {
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
  };
}

export function createDatabaseV2PutChangeSet(
  id: string,
  bundles: readonly Bundle[],
): DatabaseConnectorV2TestChangeSet {
  return {
    id,
    changes: bundles.map((value) => ({
      type: "put",
      value,
      precondition: { state: "absent" },
    })),
  };
}

export const DATABASE_V2_BUNDLE_IDS = {
  first: "018f12ab-1234-7abc-8def-000000000001",
  second: "018f12ab-1234-7abc-8def-000000000002",
  third: "018f12ab-1234-7abc-8def-000000000003",
  fourth: "018f12ab-1234-7abc-8def-000000000004",
} as const;

export const DATABASE_V2_CHANGE_SET_IDS = {
  seed: "10000000-0000-4000-8000-000000000001",
  replay: "10000000-0000-4000-8000-000000000002",
  concurrentA: "10000000-0000-4000-8000-000000000003",
  concurrentB: "10000000-0000-4000-8000-000000000004",
  unknown: "10000000-0000-4000-8000-000000000005",
  malformed: "10000000-0000-4000-8000-000000000006",
} as const;
