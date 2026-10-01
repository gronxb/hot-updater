import type {
  StorageAdapter,
  ToolingDatabase,
  ToolingTarget,
} from "@hot-updater/plugin-core";

import {
  type ClientEndpoint,
  getHotUpdaterCoreMetadata,
  type RuntimeHotUpdaterAPI,
} from "../createHotUpdaterCore";
import type { AnyHotUpdaterPlugin } from "../plugins/definePlugin";

export type { ClientEndpoint } from "../createHotUpdaterCore";

/**
 * What tooling reads from a server definition, the `hotUpdater` a module
 * exports: the database, storage, and plugins as configured, and the tables
 * and settings rows they need.
 */
export interface ServerDefinition {
  readonly database: ToolingDatabase;
  /** In order; the CLI uploads to the first. */
  readonly storage: readonly StorageAdapter[];
  readonly plugins: readonly AnyHotUpdaterPlugin[];
  readonly target: ToolingTarget;
  /**
   * The plugins' endpoints on `handlers.client`, which a host that routes
   * by path, such as a CDN in front of the server, sends to it.
   */
  readonly clientEndpoints: readonly ClientEndpoint[];
}

/**
 * The parts of `value` when it is a server definition, one
 * `createHotUpdater` returned; undefined otherwise.
 */
export const serverDefinitionOf = (
  value: unknown,
): ServerDefinition | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const metadata = getHotUpdaterCoreMetadata(value as RuntimeHotUpdaterAPI);
  if (metadata === undefined) return undefined;
  const { database, storage, plugins, target, clientEndpoints } = metadata;
  return { database, storage, plugins, target, clientEndpoints };
};
