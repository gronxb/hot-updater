import { describe, expect, it } from "vitest";
import type { Bundle, GetBundlesArgs, UpdateInfo, Platform, UpdateStatus, AppVersionGetBundlesArgs, FingerprintGetBundlesArgs } from "../types";
import { NIL_UUID } from "../uuid";
// Local type definitions to avoid circular dependency
export type StorageUri = `${string}://${string}/${string}`;

// Local semver implementation to avoid circular dependency
function semverSatisfies(targetAppVersion: string, currentVersion: string): boolean {
  // Handle wildcard
  if (targetAppVersion === "*") {
    return true;
  }
  
  // Handle exact match
  if (targetAppVersion === currentVersion) {
    return true;
  }
  
  // Handle x.x.x patterns - simple implementation for testing
  if (targetAppVersion.includes("x")) {
    const targetParts = targetAppVersion.split(".");
    const currentParts = currentVersion.split(".");
    
    for (let i = 0; i < targetParts.length; i++) {
      if (targetParts[i] === "x") {
        continue;
      }
      if (targetParts[i] !== currentParts[i]) {
        return false;
      }
    }
    return true;
  }
  
  // Simple semver compatibility check
  const parseVersion = (v: string) => {
    const parts = v.split(".").map(Number);
    return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0 };
  };
  
  const target = parseVersion(targetAppVersion);
  const current = parseVersion(currentVersion);
  
  // For now, just check if current satisfies target (simplified)
  return current.major === target.major && 
         current.minor >= target.minor && 
         (current.minor > target.minor || current.patch >= target.patch);
}

export interface DatabaseAdapter {
  readonly name: string;
  readonly dependencies?: readonly string[];
  getUpdateInfo(args: GetBundlesArgs): Promise<UpdateInfo | null>;
  getTargetAppVersions(
    platform: Platform,
    minBundleId: string,
  ): Promise<string[]>;
}

export interface StorageAdapter {
  readonly name: string;
  readonly supportedSchemas: readonly string[];
  getSignedUrl(storageUri: StorageUri, expiresIn: number): Promise<string>;
}
// Remove circular dependency by implementing inline logic

const DEFAULT_BUNDLE_APP_VERSION_STRATEGY = {
  message: "hello",
  platform: "ios",
  gitCommitHash: null,
  fileHash: "hash",
  channel: "production",
  storageUri: "storage://my-app/bundle.zip",
  fingerprintHash: null,
} as const;

const DEFAULT_BUNDLE_FINGERPRINT_STRATEGY = {
  message: "hello",
  platform: "ios",
  gitCommitHash: null,
  fileHash: "hash",
  channel: "production",
  storageUri: "storage://my-app/bundle.zip",
  targetAppVersion: null,
} as const;

const INIT_BUNDLE_ROLLBACK_UPDATE_INFO: UpdateInfo = {
  message: null,
  id: NIL_UUID,
  shouldForceUpdate: true,
  status: "ROLLBACK",
  storageUri: null,
};

const makeResponse = (bundle: Bundle, status: UpdateStatus): UpdateInfo => ({
  id: bundle.id,
  message: bundle.message,
  shouldForceUpdate: status === "ROLLBACK" ? true : bundle.shouldForceUpdate,
  status,
  storageUri: bundle.storageUri,
});

function createMockDatabaseAdapter(bundles: Bundle[]): DatabaseAdapter {
  const appVersionStrategy = async ({
    channel = "production",
    minBundleId = NIL_UUID,
    platform,
    appVersion,
    bundleId,
  }: AppVersionGetBundlesArgs): Promise<UpdateInfo | null> => {
    // Initial filtering: apply platform, channel, semver conditions, enabled status, and minBundleId condition
    const candidateBundles: Bundle[] = [];

    for (const b of bundles) {
      if (
        b.platform !== platform ||
        b.channel !== channel ||
        !b.targetAppVersion ||
        !semverSatisfies(b.targetAppVersion, appVersion) ||
        !b.enabled ||
        (minBundleId && b.id.localeCompare(minBundleId) < 0)
      ) {
        continue;
      }
      candidateBundles.push(b);
    }

    if (candidateBundles.length === 0) {
      if (
        bundleId === NIL_UUID ||
        (minBundleId && bundleId.localeCompare(minBundleId) <= 0)
      ) {
        return null;
      }
      return INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
    }

    // Determine the latest bundle, update candidate, rollback candidate, and current bundle in a single iteration
    let latestCandidate: Bundle | null = null;
    let updateCandidate: Bundle | null = null;
    let rollbackCandidate: Bundle | null = null;
    let currentBundle: Bundle | undefined = undefined;

    for (const b of candidateBundles) {
      // Latest bundle (bundle with the largest ID)
      if (!latestCandidate || b.id.localeCompare(latestCandidate.id) > 0) {
        latestCandidate = b;
      }
      // Check if current bundle exists
      if (b.id === bundleId) {
        currentBundle = b;
      } else if (bundleId !== NIL_UUID) {
        // Update candidate: largest ID among those greater than the current bundle
        if (b.id.localeCompare(bundleId) > 0) {
          if (!updateCandidate || b.id.localeCompare(updateCandidate.id) > 0) {
            updateCandidate = b;
          }
        }
        // Rollback candidate: largest ID among those smaller than the current bundle
        else if (b.id.localeCompare(bundleId) < 0) {
          if (
            !rollbackCandidate ||
            b.id.localeCompare(rollbackCandidate.id) > 0
          ) {
            rollbackCandidate = b;
          }
        }
      }
    }

    if (bundleId === NIL_UUID) {
      // For NIL_UUID, return an update if there's a latest candidate
      if (latestCandidate && latestCandidate.id.localeCompare(bundleId) > 0) {
        return makeResponse(latestCandidate, "UPDATE");
      }
      return null;
    }

    if (currentBundle) {
      // If current bundle exists, compare with latest candidate to determine update
      if (
        latestCandidate &&
        latestCandidate.id.localeCompare(currentBundle.id) > 0
      ) {
        return makeResponse(latestCandidate, "UPDATE");
      }
      return null;
    }

    // If current bundle doesn't exist, prioritize update candidate, then rollback candidate
    if (updateCandidate) {
      return makeResponse(updateCandidate, "UPDATE");
    }
    if (rollbackCandidate) {
      return makeResponse(rollbackCandidate, "ROLLBACK");
    }

    if (minBundleId && bundleId.localeCompare(minBundleId) <= 0) {
      return null;
    }
    return INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
  };

  const fingerprintStrategy = async ({
    channel = "production",
    minBundleId = NIL_UUID,
    platform,
    fingerprintHash,
    bundleId,
  }: FingerprintGetBundlesArgs): Promise<UpdateInfo | null> => {
    const candidateBundles: Bundle[] = [];

    for (const b of bundles) {
      if (
        b.platform !== platform ||
        b.channel !== channel ||
        !b.fingerprintHash ||
        b.fingerprintHash !== fingerprintHash ||
        !b.enabled ||
        (minBundleId && b.id.localeCompare(minBundleId) < 0)
      ) {
        continue;
      }
      candidateBundles.push(b);
    }

    if (candidateBundles.length === 0) {
      if (
        bundleId === NIL_UUID ||
        (minBundleId && bundleId.localeCompare(minBundleId) <= 0)
      ) {
        return null;
      }
      return INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
    }

    // Determine the latest bundle, update candidate, rollback candidate, and current bundle in a single iteration
    let latestCandidate: Bundle | null = null;
    let updateCandidate: Bundle | null = null;
    let rollbackCandidate: Bundle | null = null;
    let currentBundle: Bundle | undefined = undefined;

    for (const b of candidateBundles) {
      // Latest bundle (bundle with the largest ID)
      if (!latestCandidate || b.id.localeCompare(latestCandidate.id) > 0) {
        latestCandidate = b;
      }
      // Check if current bundle exists
      if (b.id === bundleId) {
        currentBundle = b;
      } else if (bundleId !== NIL_UUID) {
        // Update candidate: largest ID among those greater than the current bundle
        if (b.id.localeCompare(bundleId) > 0) {
          if (!updateCandidate || b.id.localeCompare(updateCandidate.id) > 0) {
            updateCandidate = b;
          }
        }
        // Rollback candidate: largest ID among those smaller than the current bundle
        else if (b.id.localeCompare(bundleId) < 0) {
          if (
            !rollbackCandidate ||
            b.id.localeCompare(rollbackCandidate.id) > 0
          ) {
            rollbackCandidate = b;
          }
        }
      }
    }

    if (bundleId === NIL_UUID) {
      // For NIL_UUID, return an update if there's a latest candidate
      if (latestCandidate && latestCandidate.id.localeCompare(bundleId) > 0) {
        return makeResponse(latestCandidate, "UPDATE");
      }
      return null;
    }

    if (currentBundle) {
      // If current bundle exists, compare with latest candidate to determine update
      if (
        latestCandidate &&
        latestCandidate.id.localeCompare(currentBundle.id) > 0
      ) {
        return makeResponse(latestCandidate, "UPDATE");
      }
      return null;
    }

    // If current bundle doesn't exist, prioritize update candidate, then rollback candidate
    if (updateCandidate) {
      return makeResponse(updateCandidate, "UPDATE");
    }
    if (rollbackCandidate) {
      return makeResponse(rollbackCandidate, "ROLLBACK");
    }

    if (minBundleId && bundleId.localeCompare(minBundleId) <= 0) {
      return null;
    }
    return INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
  };

  return {
    name: 'mock',
    async getUpdateInfo(args: GetBundlesArgs): Promise<UpdateInfo | null> {
      switch (args._updateStrategy) {
        case "appVersion":
          return appVersionStrategy(args);
        case "fingerprint":
          return fingerprintStrategy(args);
        default:
          return null;
      }
    },
    async getTargetAppVersions(platform: Platform, minBundleId: string): Promise<string[]> {
      return bundles
        .filter(b => b.platform === platform && (!minBundleId || b.id.localeCompare(minBundleId) >= 0))
        .map(b => b.targetAppVersion)
        .filter((version): version is string => version !== null && version !== undefined)
        .filter((version, index, self) => self.indexOf(version) === index);
    }
  };
}

function createMockStorageAdapter(): StorageAdapter {
  return {
    name: 'mock-storage',
    supportedSchemas: ['storage'],
    async getSignedUrl(storageUri: StorageUri, expiresIn: number): Promise<string> {
      // For testing purposes, keep the original URI to maintain test expectations
      return storageUri;
    }
  };
}

// Function overloads to support both patterns
export function setupGetUpdateInfoTestSuite({
  createHotUpdater,
}: {
  createHotUpdater: (bundles: Bundle[]) => {
    getUpdateInfo: (
      args: GetBundlesArgs,
    ) => Promise<UpdateInfo | null>;
  };
}): void;

export function setupGetUpdateInfoTestSuite({
  getUpdateInfo,
}: {
  getUpdateInfo: (
    bundles: Bundle[],
    args: GetBundlesArgs,
  ) => Promise<UpdateInfo | null>;
}): void;

export function setupGetUpdateInfoTestSuite({
  createHotUpdater,
  getUpdateInfo,
}: {
  createHotUpdater?: (bundles: Bundle[]) => {
    getUpdateInfo: (
      args: GetBundlesArgs,
    ) => Promise<UpdateInfo | null>;
  };
  getUpdateInfo?: (
    bundles: Bundle[],
    args: GetBundlesArgs,
  ) => Promise<UpdateInfo | null>;
}) {
  const createHotUpdaterInstance = createHotUpdater || ((bundles: Bundle[]) => {
    const mockDatabase = createMockDatabaseAdapter(bundles);
    return {
      getUpdateInfo: (args: GetBundlesArgs) => mockDatabase.getUpdateInfo(args)
    };
  });
  describe("app version strategy", () => {
    it("applies an update when a '*' bundle is available", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "*",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(update).toStrictEqual({
        id: "00000000-0000-0000-0000-000000000001",
        message: "hello",
        shouldForceUpdate: false,
        status: "UPDATE",
        storageUri: "storage://my-app/bundle.zip",
      });
    });

    it("returns null when no bundles are provided", async () => {
      const bundles: Bundle[] = [];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      });
      expect(update).toBeNull();
    });

    it("returns null when the app version does not qualify for the available higher version", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.1",
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
          shouldForceUpdate: false,
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      });
      expect(update).toBeNull();
    });

    it("tests target app version compatibility with available higher version", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0.0",
          enabled: true,
          id: "01963024-c131-7971-8725-ab47e232df41",
          shouldForceUpdate: false,
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0.1",
          enabled: true,
          id: "01963024-c131-7971-8725-ab47e232df42",
          shouldForceUpdate: false,
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0.0",
        bundleId: "01963024-c131-7971-8725-ab47e232df41",
        platform: "ios",
        _updateStrategy: "appVersion",
      });
      expect(update).toBeNull();
    });

    it("applies an update when a higher semver-compatible bundle is available", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.x.x",
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
          shouldForceUpdate: false,
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          enabled: true,
          id: "00000000-0000-0000-0000-000000000002",
          shouldForceUpdate: false,
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      });
      expect(update).toStrictEqual({
        id: "00000000-0000-0000-0000-000000000002",
        shouldForceUpdate: false,
        status: "UPDATE",
        message: "hello",
        storageUri: "storage://my-app/bundle.zip",
      });
    });

    it("applies an update if shouldForceUpdate is true for a matching version", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
          shouldForceUpdate: true,
        },
      ];
      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(update).toStrictEqual({
        id: "00000000-0000-0000-0000-000000000001",
        shouldForceUpdate: true,
        status: "UPDATE",
        message: "hello",
        storageUri: "storage://my-app/bundle.zip",
      });
    });

    it("applies an update for a matching version even if shouldForceUpdate is false", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
          shouldForceUpdate: false,
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      });
      expect(update).toStrictEqual({
        id: "00000000-0000-0000-0000-000000000001",
        shouldForceUpdate: false,
        status: "UPDATE",
        message: "hello",
        storageUri: "storage://my-app/bundle.zip",
      });
    });

    it("applies an update when the app version is the same but the bundle is still considered higher", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000005",
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      });
      expect(update).toStrictEqual({
        id: "00000000-0000-0000-0000-000000000005",
        shouldForceUpdate: false,
        message: "hello",
        status: "UPDATE",
        storageUri: "storage://my-app/bundle.zip",
      });
    });

    it("falls back to an older enabled bundle when the latest is disabled", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: true,
          enabled: false, // Disabled
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      });
      expect(update).toStrictEqual({
        message: "hello",
        id: "00000000-0000-0000-0000-000000000001",
        shouldForceUpdate: false,
        status: "UPDATE",
        storageUri: "storage://my-app/bundle.zip",
      });
    });

    it("returns null if all bundles are disabled", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: true,
          enabled: false, // Disabled
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: false, // Disabled
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      });
      expect(update).toBeNull();
    });

    it("triggers a rollback if the latest bundle is disabled and no other updates are enabled", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: true,
          enabled: false, // Disabled
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: false, // Disabled
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      });
      expect(update).toStrictEqual(null);
    });

    it("applies an update when a same-version bundle is available and enabled", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          shouldForceUpdate: false,
          fileHash:
            "a5cbf59a627759a88d472c502423ff55a4f6cd1aafeed3536f6a5f6e870c2290",
          message: "hi",
          targetAppVersion: "1.0",
          id: "00000000-0000-0000-0000-000000000001",
          enabled: true,
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      });
      expect(update).toStrictEqual({
        id: "00000000-0000-0000-0000-000000000001",
        shouldForceUpdate: false,
        status: "UPDATE",
        message: "hi",
        storageUri: "storage://my-app/bundle.zip",
      });
    });

    it("forces a rollback if no matching bundle exists for the provided bundleId", async () => {
      const bundles: Bundle[] = [];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0",
        bundleId: "00000000-0000-0000-0000-000000000002",
        platform: "ios",
        _updateStrategy: "appVersion",
      });
      expect(update).toStrictEqual(INIT_BUNDLE_ROLLBACK_UPDATE_INFO);
    });

    it("returns null if the user is already up-to-date with an available bundle", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0",
        bundleId: "00000000-0000-0000-0000-000000000002",
        platform: "ios",
        _updateStrategy: "appVersion",
      });
      expect(update).toBeNull();
    });

    it("triggers a rollback if the previously used bundle no longer exists", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0",
        bundleId: "00000000-0000-0000-0000-000000000002",
        platform: "ios",
        _updateStrategy: "appVersion",
      });
      expect(update).toStrictEqual({
        message: "hello",
        id: "00000000-0000-0000-0000-000000000001",
        shouldForceUpdate: true,
        status: "ROLLBACK",
        storageUri: "storage://my-app/bundle.zip",
      });
    });

    it("selects the next available bundle even if shouldForceUpdate is false", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000003",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0",
        bundleId: "00000000-0000-0000-0000-000000000002",
        platform: "ios",
        _updateStrategy: "appVersion",
      });
      expect(update).toStrictEqual({
        message: "hello",
        id: "00000000-0000-0000-0000-000000000003",
        shouldForceUpdate: false,
        status: "UPDATE",
        storageUri: "storage://my-app/bundle.zip",
      });
    });

    it("applies the highest available bundle even if the app version is unchanged", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000005", // Higher than the current version
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000004",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          platform: "ios",
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000003",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0",
        bundleId: "00000000-0000-0000-0000-000000000002",
        platform: "ios",
        _updateStrategy: "appVersion",
      });
      expect(update).toStrictEqual({
        message: "hello",
        id: "00000000-0000-0000-0000-000000000005",
        shouldForceUpdate: false,
        status: "UPDATE",
        storageUri: "storage://my-app/bundle.zip",
      });
    });

    it("returns null if the newest matching bundle is disabled", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: true,
          enabled: false, // Disabled
          id: "00000000-0000-0000-0000-000000000003",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: true,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0",
        bundleId: "00000000-0000-0000-0000-000000000002",
        platform: "ios",
        _updateStrategy: "appVersion",
      });
      expect(update).toBeNull();
    });

    it("rolls back to an older enabled bundle if the current one is disabled", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: true,
          enabled: false, // Disabled
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0",
        bundleId: "00000000-0000-0000-0000-000000000002",
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(update).toStrictEqual({
        message: "hello",
        id: "00000000-0000-0000-0000-000000000001",
        shouldForceUpdate: true, // Cause the app to reload
        status: "ROLLBACK",
        storageUri: "storage://my-app/bundle.zip",
      });
    });

    it("rolls back to the original bundle when all available bundles are disabled", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: true,
          enabled: false, // Disabled
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: false, // Disabled
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0",
        bundleId: "00000000-0000-0000-0000-000000000002",
        platform: "ios",
        _updateStrategy: "appVersion",
      });
      expect(update).toStrictEqual(INIT_BUNDLE_ROLLBACK_UPDATE_INFO);
    });

    it("returns null when there is an available bundle lower than minBundleId", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "0195715a-ce29-7c55-97d3-53af4fe369b7", // 2025-03-07T16:05:31.305Z
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0",
        minBundleId: "0195715b-9591-7000-8000-000000000000", //2025-03-07T16:06:22.353Z
        bundleId: "0195715b-9591-7000-8000-000000000000", // Build-time generated BUNDLE_ID
        platform: "ios",
        _updateStrategy: "appVersion",
      });
      expect(update).toBeNull();
    });

    it("returns the bundle when there is an available bundle higher than minBundleId", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "0195715d-42db-7475-9204-31819efc2f1d", // 2025-03-07T16:08:12.251Z
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "0195715a-ce29-7c55-97d3-53af4fe369b7", // 2025-03-07T16:05:31.305Z
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0",
        minBundleId: "0195715b-9591-7000-8000-000000000000", //2025-03-07T16:06:22.353Z
        bundleId: "0195715b-9591-7000-8000-000000000000", // Build-time generated BUNDLE_ID
        platform: "ios",
        _updateStrategy: "appVersion",
      });
      expect(update).toStrictEqual({
        id: "0195715d-42db-7475-9204-31819efc2f1d", // 2025-03-07T16:08:12.251Z
        message: "hello",
        shouldForceUpdate: false,
        status: "UPDATE",
        storageUri: "storage://my-app/bundle.zip",
      });
    });

    it("rolls back to initial bundle when current bundle is disabled and only bundles lower than minBundleId exist", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: false, // disabled
          id: "0195715d-42db-7475-9204-31819efc2f1d", // 2025-03-07T16:08:12.251Z
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "0195715a-ce29-7c55-97d3-53af4fe369b7", // 2025-03-07T16:05:31.305Z
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0",
        minBundleId: "0195715b-9591-7000-8000-000000000000", //2025-03-07T16:06:22.353Z
        bundleId: "0195715d-42db-7475-9204-31819efc2f1d", // 2025-03-07T16:08:12.251Z
        platform: "ios",
        _updateStrategy: "appVersion",
      });
      expect(update).toStrictEqual(INIT_BUNDLE_ROLLBACK_UPDATE_INFO);
    });

    it("rolls back to initial bundle when current bundle does not exist and only bundles lower than minBundleId exist", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "0195715a-ce29-7c55-97d3-53af4fe369b7", // 2025-03-07T16:05:31.305Z
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0",
        minBundleId: "0195715b-9591-7000-8000-000000000000", //2025-03-07T16:06:22.353Z
        bundleId: "0195715d-42db-7475-9204-31819efc2f1d", // 2025-03-07T16:08:12.251Z
        platform: "ios",
        _updateStrategy: "appVersion",
      });
      expect(update).toStrictEqual(INIT_BUNDLE_ROLLBACK_UPDATE_INFO);
    });

    it("returns null when current bundle is enabled and no updates are available", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true, // disabled
          id: "0195715d-42db-7475-9204-31819efc2f1d", // 2025-03-07T16:08:12.251Z
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "0195715a-ce29-7c55-97d3-53af4fe369b7", // 2025-03-07T16:05:31.305Z
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0",
        minBundleId: "0195715b-9591-7000-8000-000000000000", //2025-03-07T16:06:22.353Z
        bundleId: "0195715d-42db-7475-9204-31819efc2f1d", // 2025-03-07T16:08:12.251Z
        platform: "ios",
        _updateStrategy: "appVersion",
      });
      expect(update).toBeNull();
    });

    it("rolls back when current bundle does not exist in DB and no bundles higher than minBundleId exist", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "01957165-bee7-7df3-a25d-6686f01b02ba", //2025-03-07T16:17:28.295Z
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "01957165-19fb-75af-a361-131c17a65ef2", // 2025-03-07T16:16:46.075Z
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "01957164-fbc6-785f-98ce-a6ae459f6e4f", // 2025-03-07T16:16:38.342Z
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0",
        minBundleId: "01957166-6e63-7000-8000-000000000000", // 2025-03-07T16:18:13.219Z
        bundleId: "01957167-0389-7064-8d86-f8af7950daed", // 2025-03-07T16:18:51.401Z
        platform: "ios",
        _updateStrategy: "appVersion",
      });
      expect(update).toStrictEqual(INIT_BUNDLE_ROLLBACK_UPDATE_INFO);
    });

    it("rolls back to the bundle when current bundle does not exist in DB and a bundle exists that is higher than minBundleId but lower than current bundleId", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "0195716c-82f5-7e5e-ac8c-d4fbf5bc7555", // 2025-03-07T16:24:51.701Z
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "01957167-0389-7064-8d86-f8af7950daed", // 2025-03-07T16:18:51.401Z
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "01957165-bee7-7df3-a25d-6686f01b02ba", //2025-03-07T16:17:28.295Z
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "01957165-19fb-75af-a361-131c17a65ef2", // 2025-03-07T16:16:46.075Z
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "01957164-fbc6-785f-98ce-a6ae459f6e4f", // 2025-03-07T16:16:38.342Z
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0",
        minBundleId: "01957166-6e63-7000-8000-000000000000", // 2025-03-07T16:18:13.219Z
        bundleId: "0195716c-d426-7308-9924-c3f8cb2eaaad", // 2025-03-07T16:25:12.486Z
        platform: "ios",
        _updateStrategy: "appVersion",
      });
      expect(update).toStrictEqual({
        id: "0195716c-82f5-7e5e-ac8c-d4fbf5bc7555", // 2025-03-07T16:24:51.701Z
        message: "hello",
        shouldForceUpdate: true,
        status: "ROLLBACK",
        storageUri: "storage://my-app/bundle.zip",
      });
    });

    it("returns null when installed bundle id exactly equals minBundleId and no newer bundle is available", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "01957179-d99d-7fbb-bc1e-feff6b3236f0", // only available bundle, equal to minBundleId
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0",
        minBundleId: "0195715b-9591-7000-8000-000000000000",
        bundleId: "01957179-d99d-7fbb-bc1e-feff6b3236f0",
        platform: "ios",
        _updateStrategy: "appVersion",
      });
      expect(update).toBeNull();
    });

    it("does not update bundles from different channels", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          channel: "beta",
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0",
        bundleId: NIL_UUID,
        platform: "ios",
        channel: "production",
        _updateStrategy: "appVersion",
      });

      expect(update).toBeNull();
    });

    it("updates bundles from the same channel", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          channel: "beta",
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0",
        bundleId: NIL_UUID,
        platform: "ios",
        channel: "beta",
        _updateStrategy: "appVersion",
      });

      expect(update).toStrictEqual({
        id: "00000000-0000-0000-0000-000000000001",
        message: "hello",
        shouldForceUpdate: false,
        status: "UPDATE",
        storageUri: "storage://my-app/bundle.zip",
      });
    });

    it("returns null when minBundleId is greater than current bundle", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          enabled: true,
          shouldForceUpdate: false,
          targetAppVersion: "1.0",
          id: "01957b63-7d11-7281-b8e7-1120ccfdb8ab",
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0",
        bundleId: "01957b63-7d11-7281-b8e7-1120ccfdb8ab",
        platform: "ios",
        minBundleId: "01957bb4-b13c-7000-8000-000000000000",
        channel: "production",
        _updateStrategy: "appVersion",
      });

      expect(update).toBeNull();
    });

    it("returns null when there are no bundles and minBundleId equals bundleId", async () => {
      const bundles: Bundle[] = [];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0",
        bundleId: "0195d325-767a-7000-8000-000000000000",
        platform: "ios",
        minBundleId: "0195d325-767a-7000-8000-000000000000",
        channel: "production",
        _updateStrategy: "appVersion",
      });

      expect(update).toBeNull();
    });

    it("returns null when there are no bundles and minBundleId equals bundleId", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          enabled: true,
          shouldForceUpdate: true,
          id: "01963024-c131-7971-8725-ab47e232df40",
          platform: "ios",
          targetAppVersion: "1.0.0",
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0",
        bundleId: "00000000-0000-0000-0000-000000000000",
        platform: "ios",
        minBundleId: "00000000-0000-0000-0000-000000000000",
        channel: "production",
        _updateStrategy: "appVersion",
      });

      expect(update).toStrictEqual({
        id: "01963024-c131-7971-8725-ab47e232df40",
        message: "hello",
        shouldForceUpdate: true,
        status: "UPDATE",
        storageUri: "storage://my-app/bundle.zip",
      });
    });
  });

  describe("fingerprint strategy", () => {
    it("returns null when no bundles are provided", async () => {
      const bundles: Bundle[] = [];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "fingerprint",
      });
      expect(update).toBeNull();
    });

    it("returns null when the app version does not qualify for the available higher version", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash2",
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
          shouldForceUpdate: false,
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "fingerprint",
      });
      expect(update).toBeNull();
    });

    it("tests target app version compatibility with available higher version", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          enabled: true,
          id: "01963024-c131-7971-8725-ab47e232df41",
          shouldForceUpdate: false,
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash2",
          enabled: true,
          id: "01963024-c131-7971-8725-ab47e232df42",
          shouldForceUpdate: false,
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: "01963024-c131-7971-8725-ab47e232df41",
        platform: "ios",
        _updateStrategy: "fingerprint",
      });
      expect(update).toBeNull();
    });

    it("applies an update when a higher semver-compatible bundle is available", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
          shouldForceUpdate: false,
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash2",
          enabled: true,
          id: "00000000-0000-0000-0000-000000000002",
          shouldForceUpdate: false,
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "fingerprint",
      });
      expect(update).toStrictEqual({
        id: "00000000-0000-0000-0000-000000000001",
        shouldForceUpdate: false,
        status: "UPDATE",
        message: "hello",
        storageUri: "storage://my-app/bundle.zip",
      });
    });

    it("applies an update if shouldForceUpdate is true for a matching version", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
          shouldForceUpdate: true,
        },
      ];
      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "fingerprint",
      });

      expect(update).toStrictEqual({
        id: "00000000-0000-0000-0000-000000000001",
        shouldForceUpdate: true,
        status: "UPDATE",
        message: "hello",
        storageUri: "storage://my-app/bundle.zip",
      });
    });

    it("applies an update for a matching version even if shouldForceUpdate is false", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
          shouldForceUpdate: false,
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "fingerprint",
      });
      expect(update).toStrictEqual({
        id: "00000000-0000-0000-0000-000000000001",
        shouldForceUpdate: false,
        status: "UPDATE",
        message: "hello",
        storageUri: "storage://my-app/bundle.zip",
      });
    });

    it("applies an update when the app version is the same but the bundle is still considered higher", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000005",
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "fingerprint",
      });
      expect(update).toStrictEqual({
        id: "00000000-0000-0000-0000-000000000005",
        shouldForceUpdate: false,
        message: "hello",
        status: "UPDATE",
        storageUri: "storage://my-app/bundle.zip",
      });
    });

    it("falls back to an older enabled bundle when the latest is disabled", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: true,
          enabled: false, // Disabled
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "fingerprint",
      });
      expect(update).toStrictEqual({
        message: "hello",
        id: "00000000-0000-0000-0000-000000000001",
        shouldForceUpdate: false,
        status: "UPDATE",
        storageUri: "storage://my-app/bundle.zip",
      });
    });

    it("returns null if all bundles are disabled", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: true,
          enabled: false, // Disabled
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: false, // Disabled
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "fingerprint",
      });
      expect(update).toBeNull();
    });

    it("triggers a rollback if the latest bundle is disabled and no other updates are enabled", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: true,
          enabled: false, // Disabled
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: false, // Disabled
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "fingerprint",
      });
      expect(update).toStrictEqual(null);
    });

    it("applies an update when a same-version bundle is available and enabled", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          shouldForceUpdate: false,
          fileHash:
            "a5cbf59a627759a88d472c502423ff55a4f6cd1aafeed3536f6a5f6e870c2290",
          message: "hi",
          fingerprintHash: "hash1",
          id: "00000000-0000-0000-0000-000000000001",
          enabled: true,
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "fingerprint",
      });
      expect(update).toStrictEqual({
        id: "00000000-0000-0000-0000-000000000001",
        shouldForceUpdate: false,
        status: "UPDATE",
        message: "hi",
        storageUri: "storage://my-app/bundle.zip",
      });
    });

    it("forces a rollback if no matching bundle exists for the provided bundleId", async () => {
      const bundles: Bundle[] = [];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        appVersion: "1.0",
        bundleId: "00000000-0000-0000-0000-000000000002",
        platform: "ios",
        _updateStrategy: "appVersion",
      });
      expect(update).toStrictEqual(INIT_BUNDLE_ROLLBACK_UPDATE_INFO);
    });

    it("returns null if the user is already up-to-date with an available bundle", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: "00000000-0000-0000-0000-000000000002",
        platform: "ios",
        _updateStrategy: "fingerprint",
      });
      expect(update).toBeNull();
    });

    it("triggers a rollback if the previously used bundle no longer exists", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: "00000000-0000-0000-0000-000000000002",
        platform: "ios",
        _updateStrategy: "fingerprint",
      });
      expect(update).toStrictEqual({
        message: "hello",
        id: "00000000-0000-0000-0000-000000000001",
        shouldForceUpdate: true,
        status: "ROLLBACK",
        storageUri: "storage://my-app/bundle.zip",
      });
    });

    it("selects the next available bundle even if shouldForceUpdate is false", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000003",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: "00000000-0000-0000-0000-000000000002",
        platform: "ios",
        _updateStrategy: "fingerprint",
      });
      expect(update).toStrictEqual({
        message: "hello",
        id: "00000000-0000-0000-0000-000000000003",
        shouldForceUpdate: false,
        status: "UPDATE",
        storageUri: "storage://my-app/bundle.zip",
      });
    });

    it("applies the highest available bundle even if the app version is unchanged", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000005", // Higher than the current version
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000004",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000003",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: "00000000-0000-0000-0000-000000000002",
        platform: "ios",
        _updateStrategy: "fingerprint",
      });
      expect(update).toStrictEqual({
        message: "hello",
        id: "00000000-0000-0000-0000-000000000005",
        shouldForceUpdate: false,
        status: "UPDATE",
        storageUri: "storage://my-app/bundle.zip",
      });
    });

    it("returns null if the newest matching bundle is disabled", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: true,
          enabled: false, // Disabled
          id: "00000000-0000-0000-0000-000000000003",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: true,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: "00000000-0000-0000-0000-000000000002",
        platform: "ios",
        _updateStrategy: "fingerprint",
      });
      expect(update).toBeNull();
    });

    it("rolls back to an older enabled bundle if the current one is disabled", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: true,
          enabled: false, // Disabled
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: "00000000-0000-0000-0000-000000000002",
        platform: "ios",
        _updateStrategy: "fingerprint",
      });

      expect(update).toStrictEqual({
        message: "hello",
        id: "00000000-0000-0000-0000-000000000001",
        shouldForceUpdate: true, // Cause the app to reload
        status: "ROLLBACK",
        storageUri: "storage://my-app/bundle.zip",
      });
    });

    it("rolls back to the original bundle when all available bundles are disabled", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: true,
          enabled: false, // Disabled
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: false, // Disabled
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: "00000000-0000-0000-0000-000000000002",
        platform: "ios",
        _updateStrategy: "fingerprint",
      });
      expect(update).toStrictEqual(INIT_BUNDLE_ROLLBACK_UPDATE_INFO);
    });

    it("returns null when there is an available bundle lower than minBundleId", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "0195715a-ce29-7c55-97d3-53af4fe369b7", // 2025-03-07T16:05:31.305Z
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        fingerprintHash: "hash1",
        minBundleId: "0195715b-9591-7000-8000-000000000000", //2025-03-07T16:06:22.353Z
        bundleId: "0195715b-9591-7000-8000-000000000000", // Build-time generated BUNDLE_ID
        platform: "ios",
        _updateStrategy: "fingerprint",
      });
      expect(update).toBeNull();
    });

    it("returns the bundle when there is an available bundle higher than minBundleId", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "0195715d-42db-7475-9204-31819efc2f1d", // 2025-03-07T16:08:12.251Z
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "0195715a-ce29-7c55-97d3-53af4fe369b7", // 2025-03-07T16:05:31.305Z
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        fingerprintHash: "hash1",
        minBundleId: "0195715b-9591-7000-8000-000000000000", //2025-03-07T16:06:22.353Z
        bundleId: "0195715b-9591-7000-8000-000000000000", // Build-time generated BUNDLE_ID
        platform: "ios",
        _updateStrategy: "fingerprint",
      });
      expect(update).toStrictEqual({
        id: "0195715d-42db-7475-9204-31819efc2f1d", // 2025-03-07T16:08:12.251Z
        message: "hello",
        shouldForceUpdate: false,
        status: "UPDATE",
        storageUri: "storage://my-app/bundle.zip",
      });
    });

    it("rolls back to initial bundle when current bundle is disabled and only bundles lower than minBundleId exist", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: false, // disabled
          id: "0195715d-42db-7475-9204-31819efc2f1d", // 2025-03-07T16:08:12.251Z
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "0195715a-ce29-7c55-97d3-53af4fe369b7", // 2025-03-07T16:05:31.305Z
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        fingerprintHash: "hash1",
        minBundleId: "0195715b-9591-7000-8000-000000000000", //2025-03-07T16:06:22.353Z
        bundleId: "0195715d-42db-7475-9204-31819efc2f1d", // 2025-03-07T16:08:12.251Z
        platform: "ios",
        _updateStrategy: "fingerprint",
      });
      expect(update).toStrictEqual(INIT_BUNDLE_ROLLBACK_UPDATE_INFO);
    });

    it("rolls back to initial bundle when current bundle does not exist and only bundles lower than minBundleId exist", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "0195715a-ce29-7c55-97d3-53af4fe369b7", // 2025-03-07T16:05:31.305Z
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        fingerprintHash: "hash1",
        minBundleId: "0195715b-9591-7000-8000-000000000000", //2025-03-07T16:06:22.353Z
        bundleId: "0195715d-42db-7475-9204-31819efc2f1d", // 2025-03-07T16:08:12.251Z
        platform: "ios",
        _updateStrategy: "fingerprint",
      });
      expect(update).toStrictEqual(INIT_BUNDLE_ROLLBACK_UPDATE_INFO);
    });

    it("returns null when current bundle is enabled and no updates are available", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true, // disabled
          id: "0195715d-42db-7475-9204-31819efc2f1d", // 2025-03-07T16:08:12.251Z
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "0195715a-ce29-7c55-97d3-53af4fe369b7", // 2025-03-07T16:05:31.305Z
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        fingerprintHash: "hash1",
        minBundleId: "0195715b-9591-7000-8000-000000000000", //2025-03-07T16:06:22.353Z
        bundleId: "0195715d-42db-7475-9204-31819efc2f1d", // 2025-03-07T16:08:12.251Z
        platform: "ios",
        _updateStrategy: "fingerprint",
      });
      expect(update).toBeNull();
    });

    it("rolls back when current bundle does not exist in DB and no bundles higher than minBundleId exist", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "01957165-bee7-7df3-a25d-6686f01b02ba", //2025-03-07T16:17:28.295Z
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "01957165-19fb-75af-a361-131c17a65ef2", // 2025-03-07T16:16:46.075Z
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "01957164-fbc6-785f-98ce-a6ae459f6e4f", // 2025-03-07T16:16:38.342Z
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        fingerprintHash: "hash1",
        minBundleId: "01957166-6e63-7000-8000-000000000000", // 2025-03-07T16:18:13.219Z
        bundleId: "01957167-0389-7064-8d86-f8af7950daed", // 2025-03-07T16:18:51.401Z
        platform: "ios",
        _updateStrategy: "fingerprint",
      });
      expect(update).toStrictEqual(INIT_BUNDLE_ROLLBACK_UPDATE_INFO);
    });

    it("rolls back to the bundle when current bundle does not exist in DB and a bundle exists that is higher than minBundleId but lower than current bundleId", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "0195716c-82f5-7e5e-ac8c-d4fbf5bc7555", // 2025-03-07T16:24:51.701Z
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "01957167-0389-7064-8d86-f8af7950daed", // 2025-03-07T16:18:51.401Z
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "01957165-bee7-7df3-a25d-6686f01b02ba", //2025-03-07T16:17:28.295Z
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "01957165-19fb-75af-a361-131c17a65ef2", // 2025-03-07T16:16:46.075Z
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "01957164-fbc6-785f-98ce-a6ae459f6e4f", // 2025-03-07T16:16:38.342Z
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        fingerprintHash: "hash1",
        minBundleId: "01957166-6e63-7000-8000-000000000000", // 2025-03-07T16:18:13.219Z
        bundleId: "0195716c-d426-7308-9924-c3f8cb2eaaad", // 2025-03-07T16:25:12.486Z
        platform: "ios",
        _updateStrategy: "fingerprint",
      });
      expect(update).toStrictEqual({
        id: "0195716c-82f5-7e5e-ac8c-d4fbf5bc7555", // 2025-03-07T16:24:51.701Z
        message: "hello",
        shouldForceUpdate: true,
        status: "ROLLBACK",
        storageUri: "storage://my-app/bundle.zip",
      });
    });

    it("returns null when installed bundle id exactly equals minBundleId and no newer bundle is available", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "01957179-d99d-7fbb-bc1e-feff6b3236f0", // only available bundle, equal to minBundleId
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        fingerprintHash: "hash1",
        minBundleId: "0195715b-9591-7000-8000-000000000000",
        bundleId: "01957179-d99d-7fbb-bc1e-feff6b3236f0",
        platform: "ios",
        _updateStrategy: "fingerprint",
      });
      expect(update).toBeNull();
    });

    it("does not update bundles from different channels", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          channel: "beta",
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: NIL_UUID,
        platform: "ios",
        channel: "production",
        _updateStrategy: "fingerprint",
      });

      expect(update).toBeNull();
    });

    it("updates bundles from the same channel", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          channel: "beta",
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: NIL_UUID,
        platform: "ios",
        channel: "beta",
        _updateStrategy: "fingerprint",
      });

      expect(update).toStrictEqual({
        id: "00000000-0000-0000-0000-000000000001",
        message: "hello",
        shouldForceUpdate: false,
        status: "UPDATE",
        storageUri: "storage://my-app/bundle.zip",
      });
    });

    it("returns null when minBundleId is greater than current bundle", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          enabled: true,
          shouldForceUpdate: false,
          id: "01957b63-7d11-7281-b8e7-1120ccfdb8ab",
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: "01957b63-7d11-7281-b8e7-1120ccfdb8ab",
        platform: "ios",
        minBundleId: "01957bb4-b13c-7000-8000-000000000000",
        channel: "production",
        _updateStrategy: "fingerprint",
      });

      expect(update).toBeNull();
    });

    it("returns null when there are no bundles and minBundleId equals bundleId", async () => {
      const bundles: Bundle[] = [];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: "0195d325-767a-7000-8000-000000000000",
        platform: "ios",
        minBundleId: "0195d325-767a-7000-8000-000000000000",
        channel: "production",
        _updateStrategy: "fingerprint",
      });

      expect(update).toBeNull();
    });

    it("returns null when there are no bundles and minBundleId equals bundleId", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          enabled: true,
          shouldForceUpdate: true,
          id: "01963024-c131-7971-8725-ab47e232df40",
          platform: "ios",
          fingerprintHash: "hash1",
        },
      ];

      const hotUpdater = createHotUpdaterInstance(bundles);
      const update = await hotUpdater.getUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: "00000000-0000-0000-0000-000000000000",
        platform: "ios",
        minBundleId: "00000000-0000-0000-0000-000000000000",
        channel: "production",
        _updateStrategy: "fingerprint",
      });

      expect(update).toStrictEqual({
        id: "01963024-c131-7971-8725-ab47e232df40",
        message: "hello",
        shouldForceUpdate: true,
        status: "UPDATE",
        storageUri: "storage://my-app/bundle.zip",
      });
    });
  });
};

export const createDefaultHotUpdaterTestInstance = (bundles: Bundle[]) => {
  const database = createMockDatabaseAdapter(bundles);
  const storage = createMockStorageAdapter();
  
  return {
    getUpdateInfo: async (args: GetBundlesArgs): Promise<UpdateInfo | null> => {
      const updateInfo = await database.getUpdateInfo(args);
      
      if (!updateInfo || !updateInfo.storageUri) {
        return updateInfo;
      }

      // Convert storage URI to signed URL
      const signedUrl = await storage.getSignedUrl(updateInfo.storageUri as StorageUri, 3600);
      
      return {
        ...updateInfo,
        storageUri: signedUrl
      };
    }
  };
};
