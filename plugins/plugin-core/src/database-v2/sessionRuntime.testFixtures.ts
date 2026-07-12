import type { Bundle } from "@hot-updater/core";

import type { BundleChangeSetV2 } from "./bundles";
import type { Sha256Digest } from "./common";
import { ScriptedRuntimeBackend } from "./sessionRuntime.testBackend";
import type {
  MutableScopeFixture,
  TestConnectionRuntimeFactoryV2,
} from "./sessionRuntime.testTypes";

export const createRuntimeBundle = (
  id: string,
  channel = "production",
): Bundle => ({
  id,
  channel,
  platform: "ios",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: `hash-${id}`,
  storageUri: `memory://${id}`,
  gitCommitHash: null,
  message: id,
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
});

export const createRuntimeChangeSet = (
  id: string,
  bundleId = "018f12ab-1234-7abc-8def-000000000001",
): BundleChangeSetV2 => ({
  id,
  changes: [
    {
      type: "put",
      value: createRuntimeBundle(bundleId),
      precondition: { state: "absent" },
    },
  ],
});

export const createRuntimeScope = (): MutableScopeFixture => ({
  tenantId: "tenant-a",
  principalId: "principal-a",
  context: {
    marker: "trusted-host",
    tenantId: "context-tenant-must-not-win",
    principalId: "context-principal-must-not-win",
  },
});

export const CHANGE_SET_IDS = {
  first: "10000000-0000-4000-8000-000000000001",
  second: "10000000-0000-4000-8000-000000000002",
  third: "10000000-0000-4000-8000-000000000003",
} as const;

export const setupRuntimeSubject = <TContext>(
  factory: TestConnectionRuntimeFactoryV2,
  options?: {
    readonly dispose?: () => Promise<void>;
    readonly sha256?: Sha256Digest;
  },
) => {
  const backend = new ScriptedRuntimeBackend();
  const resource =
    options?.dispose === undefined
      ? ({ ownership: "borrowed" } as const)
      : ({ ownership: "owned", dispose: options.dispose } as const);
  const connection = factory<TContext>({
    backend,
    resource,
    ...(options?.sha256 === undefined ? {} : { sha256: options.sha256 }),
  });
  return { backend, connection };
};
