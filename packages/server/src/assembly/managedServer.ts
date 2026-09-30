import {
  type ServerDefinition,
  serverDefinitionOf,
} from "../db/serverDefinition";
import { HotUpdaterConfigError } from "./configError";

/** A managed server: where it runs, and the database and storage it runs on. */
export interface ManagedServer {
  /** For messages, such as "Cloudflare". */
  readonly provider: string;
  /** The name its database reports, such as `d1Database`. */
  readonly database: string;
  /** The protocol of its storage's URIs, such as `r2`. */
  readonly storage: string;
}

/**
 * The project's server definition, as a managed server runs it. The managed
 * runtime serves the definition on its own database and storage, so the
 * definition's must be the provider's; its plugins are the project's,
 * including none of Hot Updater's own.
 */
export const managedServerDefinitionOf = (
  hotUpdater: unknown,
  { provider, database, storage }: ManagedServer,
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
  return definition;
};
