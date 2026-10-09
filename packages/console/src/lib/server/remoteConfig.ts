import type { RemoteDatabase } from "@hot-updater/plugin-core";
import {
  createRemoteConfigAdminApi,
  type RemoteConfigActive,
  type RemoteConfigAdminApi,
  type RemoteConfigPublishResult,
  type RemoteConfigTemplateIssue,
  RemoteConfigValidationError,
  type RemoteConfigVersionDetail,
  type RemoteConfigVersionsPage,
} from "@hot-updater/server/plugins/remote-config";

import { ConsoleFeatureUnavailableError } from "../console-features";

/** How a publish from the console ended; `invalid` lists what to fix. */
export type ConsolePublishResult =
  | RemoteConfigPublishResult
  | {
      readonly status: "invalid";
      readonly issues: readonly RemoteConfigTemplateIssue[];
    };

/** The Remote Config the console pages use. */
export interface ConsoleRemoteConfig {
  getActive(): Promise<RemoteConfigActive>;
  listVersions(input: {
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<RemoteConfigVersionsPage>;
  getVersion(version: number): Promise<RemoteConfigVersionDetail | null>;
  publish(input: {
    readonly template: unknown;
    readonly baseVersion: number;
    readonly description?: string;
  }): Promise<ConsolePublishResult>;
  rollback(input: {
    readonly version: number;
    readonly baseVersion: number;
  }): Promise<ConsolePublishResult | { readonly status: "not_found" }>;
}

const invalidOf = (error: unknown): ConsolePublishResult => {
  if (error instanceof RemoteConfigValidationError) {
    return { status: "invalid", issues: error.issues };
  }
  throw error;
};

/**
 * Remote Config over the `remoteConfig()` API the console assembled on the
 * database, or over the admin routes, which answer as the API does.
 */
export const createLocalRemoteConfig = (
  api: RemoteConfigAdminApi,
): ConsoleRemoteConfig => ({
  getActive: () => api.getActive(),
  listVersions: (input) => api.listVersions(input),
  getVersion: (version) => api.getVersion(version),
  publish: (input) => api.publish(input).catch(invalidOf),
  rollback: (input) => api.rollback(input),
});

/**
 * Remote Config over a self-hosted server's admin routes. A route the server
 * does not mount answers core's 404: it runs without `remoteConfig()`.
 */
export const createAdminRemoteConfig = (
  fetchAdmin: RemoteDatabase["fetchAdmin"],
): ConsoleRemoteConfig =>
  createLocalRemoteConfig(
    createRemoteConfigAdminApi(fetchAdmin, {
      unavailable: () =>
        new ConsoleFeatureUnavailableError("remoteConfig", { remote: true }),
    }),
  );
