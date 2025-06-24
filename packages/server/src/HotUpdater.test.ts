import { describe, it, expect } from 'vitest';
import { setupGetUpdateInfoTestSuite } from '@hot-updater/core/test-utils';
import { HotUpdater } from './HotUpdater';
import type { DatabaseAdapter, StorageAdapter } from './types';
import type { Bundle, GetBundlesArgs, UpdateInfo, Platform, AppVersionGetBundlesArgs, FingerprintGetBundlesArgs } from '@hot-updater/core';
import { NIL_UUID } from '@hot-updater/core';
import semver from 'semver';

const semverSatisfies = (targetAppVersion: string, currentVersion: string) => {
  const currentCoerce = semver.coerce(currentVersion);
  if (!currentCoerce) {
    return false;
  }
  return semver.satisfies(currentCoerce.version, targetAppVersion);
};

const INIT_BUNDLE_ROLLBACK_UPDATE_INFO: UpdateInfo = {
  message: null,
  id: NIL_UUID,
  shouldForceUpdate: true,
  status: "ROLLBACK",
  storageUri: null,
};

const makeResponse = (bundle: Bundle, status: "UPDATE" | "ROLLBACK") => ({
  id: bundle.id,
  message: bundle.message,
  shouldForceUpdate: status === "ROLLBACK" ? true : bundle.shouldForceUpdate,
  status,
  storageUri: bundle.storageUri,
});

// Create a real database adapter that implements the full update logic
function createRealDatabaseAdapter(bundles: Bundle[]): DatabaseAdapter {
  return {
    name: 'real',
    async getUpdateInfo(args: GetBundlesArgs): Promise<UpdateInfo | null> {
      switch (args._updateStrategy) {
        case "appVersion":
          return appVersionStrategy(bundles, args as AppVersionGetBundlesArgs);
        case "fingerprint":
          return fingerprintStrategy(bundles, args as FingerprintGetBundlesArgs);
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

const appVersionStrategy = async (
  bundles: Bundle[],
  {
    channel = "production",
    minBundleId = NIL_UUID,
    platform,
    appVersion,
    bundleId,
  }: AppVersionGetBundlesArgs,
): Promise<UpdateInfo | null> => {
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

const fingerprintStrategy = async (
  bundles: Bundle[],
  {
    channel = "production",
    minBundleId = NIL_UUID,
    platform,
    fingerprintHash,
    bundleId,
  }: FingerprintGetBundlesArgs,
): Promise<UpdateInfo | null> => {
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

function createMockStorageAdapter(): StorageAdapter {
  return {
    name: 'mock-storage',
    supportedSchemas: ['storage'],
    async getSignedUrl(storageUri, expiresIn) {
      // For testing purposes, keep the original URI to maintain test expectations
      return storageUri;
    }
  };
}

// Run the standard test suite
setupGetUpdateInfoTestSuite({
  createHotUpdater: (bundles: Bundle[]) => {
    const hotUpdater = new HotUpdater({
      database: createRealDatabaseAdapter(bundles),
      storage: createMockStorageAdapter()
    });
    
    return {
      getUpdateInfo: async (args) => {
        const result = await hotUpdater.getUpdateInfo(args);
        if (!result) return null;
        // Convert UpdateResponse back to UpdateInfo for test compatibility
        return {
          id: result.id,
          message: result.message,
          shouldForceUpdate: result.shouldForceUpdate,
          status: result.status,
          storageUri: result.fileUrl,
        };
      }
    };
  }
});

describe('HotUpdater', () => {
  it('should reject incompatible adapters', () => {
    const d1Database: DatabaseAdapter = {
      name: 'd1',
      dependencies: ['r2', 'cloudfront'],
      async getUpdateInfo() { return null; },
      async getTargetAppVersions() { return []; }
    };

    const supabaseStorage: StorageAdapter = {
      name: 'supabase',
      supportedSchemas: ['supabase'],
      async getSignedUrl() { return ''; }
    };

    expect(() => new HotUpdater({
      database: d1Database,
      storage: supabaseStorage
    })).toThrow('Adapter compatibility error');
  });

  it('should accept compatible adapters', () => {
    const mockDatabase: DatabaseAdapter = {
      name: 'mock',
      async getUpdateInfo() { return null; },
      async getTargetAppVersions() { return []; }
    };

    const mockStorage: StorageAdapter = {
      name: 'mock-storage',
      supportedSchemas: ['mock'],
      async getSignedUrl() { return ''; }
    };

    expect(() => new HotUpdater({
      database: mockDatabase,
      storage: mockStorage
    })).not.toThrow();
  });
});