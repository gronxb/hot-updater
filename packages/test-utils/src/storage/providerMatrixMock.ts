import { createStorageOperationContext } from "@hot-updater/core/config";
import type {
  StorageOperationContext,
  StoragePlugin,
} from "@hot-updater/plugin-core/storage";

import { mockStorage as mockNeutralStorage } from "../../../../plugins/mock/src/storage";
import { mockStorage as mockNodeStorage } from "../../../../plugins/mock/src/storage/node";
import type { ProviderMatrixObservation } from "./providerMatrixTypes";
import {
  REQUIRED_CONTEXTS,
  REQUIRED_OPERATIONS,
  REQUIRED_ORIGINS,
} from "./providerMatrixTypes";

type MockFactory = (
  config: Readonly<{
    assertContext: (
      context: StorageOperationContext,
      operation: "put" | "head" | "get" | "delete",
    ) => void;
  }>,
) => StoragePlugin;

const observeMockEntry = async (
  id: string,
  entry: string,
  targets: readonly ("node" | "worker" | "functions" | "edge")[],
  factory: MockFactory,
): Promise<ProviderMatrixObservation> => {
  const calls: string[] = [];
  const plugin = factory({
    assertContext(context, operation) {
      calls.push(`${context.environment.REQUEST_ID}:${operation}`);
    },
  });
  const contexts = REQUIRED_CONTEXTS.map((requestId, index) =>
    createStorageOperationContext({
      target: targets[index % targets.length] ?? "node",
      environment: { REQUEST_ID: requestId },
      bindings: {},
    }),
  );

  const stored = await Promise.all(
    contexts.map((context, index) =>
      plugin.put({
        context,
        key: `matrix/${REQUIRED_ORIGINS[index]}-${index}`,
        body: new Uint8Array([index + 1]),
        contentLength: 1,
        condition: "create-only",
      }),
    ),
  );
  const firstUri = stored[0]?.storageUri ?? "";
  await plugin.head({ context: contexts[0], storageUri: firstUri });
  const found = await plugin.get({
    context: contexts[0],
    storageUri: firstUri,
    range: { start: 0, end: 0 },
  });
  if (found.kind === "found") {
    await new Response(found.body).arrayBuffer();
  }
  await plugin.delete({ context: contexts[0], storageUri: firstUri });
  await plugin.onUnmount?.();

  return {
    id,
    entry,
    targets,
    contexts: REQUIRED_CONTEXTS,
    operations: REQUIRED_OPERATIONS,
    origins: REQUIRED_ORIGINS,
    providerVisible: {
      contextCalls: calls,
      distinctContainers: new Set(contexts).size,
      streamed: found.kind === "found",
    },
    cache: { literal: "allowed", tagged: "forbidden" },
    streamLifetime: "borrowed",
    secretCanaryLeaked: false,
  };
};

export const observeMockMatrix = async (): Promise<
  readonly ProviderMatrixObservation[]
> =>
  Promise.all([
    observeMockEntry(
      "mock-neutral",
      "@hot-updater/mock/storage",
      ["node", "worker", "functions", "edge"],
      mockNeutralStorage,
    ),
    observeMockEntry(
      "mock-node",
      "@hot-updater/mock/storage/node",
      ["node"],
      mockNodeStorage,
    ),
  ]);
