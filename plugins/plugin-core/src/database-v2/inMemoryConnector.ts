import type { DatabaseConnectorV2 } from "./connector";
import { createInMemoryDatabaseBackendV2 } from "./inMemoryBackend";
import type { InMemoryDatabaseConnectorV2Options } from "./manifest";
import { IN_MEMORY_DATABASE_CONNECTOR_MANIFEST_V2 } from "./referenceManifest";
import { createDatabaseConnectionRuntimeV2 } from "./sessionRuntime";

export const createInMemoryDatabaseConnectorV2 = <TContext = unknown>(
  options: InMemoryDatabaseConnectorV2Options = {},
): DatabaseConnectorV2<TContext> => {
  const backend = createInMemoryDatabaseBackendV2(options);
  return Object.freeze({
    manifest: IN_MEMORY_DATABASE_CONNECTOR_MANIFEST_V2,
    connect: () =>
      createDatabaseConnectionRuntimeV2<TContext>({
        backend,
        resource: { ownership: "borrowed" },
        ...(options.sha256 === undefined ? {} : { sha256: options.sha256 }),
      }),
  });
};
