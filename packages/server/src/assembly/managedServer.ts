import {
  type AdapterResource,
  adapterResourceOf,
} from "@hot-updater/plugin-core";
import { createMemoryAdapter } from "@hot-updater/plugin-core/internal";

import type { ClientEndpoint } from "../createHotUpdaterCore";
import {
  type ServerDefinition,
  serverDefinitionOf,
} from "../db/serverDefinition";
import { assemblePlugins } from "./assemblePlugins";
import { HotUpdaterConfigError } from "./configError";

/**
 * The endpoints `plugins` add to `handlers.client`, as a server running them
 * mounts them: what a host that routes by path, such as a CDN in front of a
 * managed server, sends to it. The plugins start on a database in memory,
 * which they do not read until a request.
 */
export const clientEndpointsOf = (
  plugins: readonly unknown[],
): readonly ClientEndpoint[] =>
  assemblePlugins(plugins, createMemoryAdapter())
    .endpoints.filter((endpoint) => endpoint.access === "client")
    .map(({ plugin, method, path }) => ({ plugin, method, path }));

/** A managed server: where it runs, and the database and storage it runs on. */
export interface ManagedServer {
  /** For messages, such as "Cloudflare". */
  readonly provider: string;
  /** The name its database reports, such as `d1Database`. */
  readonly database: string;
  /** The protocol of its storage's URIs, such as `r2`. */
  readonly storage: string;
  /**
   * The resources the managed server runs on, as its setup made them. The
   * definition's adapters must reach the same, or the CLI would read and
   * write others than the server does.
   */
  readonly resources?: {
    readonly database?: AdapterResource;
    readonly storage?: AdapterResource;
  };
}

/** Refuses an adapter that reaches a resource other than the managed server's. */
const assertSameResource = (
  provider: string,
  adapter: { readonly name: string },
  expected: AdapterResource | undefined,
) => {
  const actual = adapterResourceOf(adapter);
  for (const [key, value] of Object.entries(expected ?? {})) {
    const found = actual?.[key];
    if (value === undefined || found === undefined || found === value) {
      continue;
    }
    throw new HotUpdaterConfigError(
      `The managed ${provider} server runs on ${key} ${value}, which its setup made, but the server definition's ${adapter.name} has ${key} ${found}, so the CLI would read and write another one. Give it ${value}, as .env.hotupdater holds it, or host the server yourself.`,
    );
  }
};

/**
 * The project's server definition, as a managed server runs it. The managed
 * runtime serves the definition on its own database and storage, so the
 * definition's must be the provider's, on the resources its setup made; its
 * plugins are the project's, including none of Hot Updater's own.
 */
export const managedServerDefinitionOf = (
  hotUpdater: unknown,
  { provider, database, storage, resources }: ManagedServer,
): ServerDefinition => {
  const definition = serverDefinitionOf(hotUpdater);
  if (definition === undefined) {
    throw new HotUpdaterConfigError(
      "The server definition must export hotUpdater, the value createHotUpdater({ database, storage, plugins }) returns.",
    );
  }
  if (definition.database.name !== database) {
    throw new HotUpdaterConfigError(
      `The managed ${provider} server runs on ${database}, but the server definition's database is ${definition.database.name}. Use ${database}, or host the server yourself.`,
    );
  }
  const others = definition.storage.filter(
    (adapter) => adapter.protocol !== storage,
  );
  if (definition.storage.length === 0 || others.length > 0) {
    throw new HotUpdaterConfigError(
      `The managed ${provider} server stores bundles in its ${storage} storage, but the server definition's storage is ${definition.storage.map((adapter) => adapter.name).join(", ") || "empty"}. List only the provider's storage, or host the server yourself.`,
    );
  }
  assertSameResource(provider, definition.database, resources?.database);
  for (const adapter of definition.storage) {
    assertSameResource(provider, adapter, resources?.storage);
  }
  return definition;
};
