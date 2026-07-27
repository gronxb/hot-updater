import {
  createStorageOperationContext,
  env,
  secret,
} from "@hot-updater/core/config";
import type { StoragePlugin } from "@hot-updater/plugin-core/storage";
import { vi } from "vitest";

import { createStandaloneStorageHandler } from "../../../../plugins/standalone/src/standaloneStorageHandler";
import { createProviderMatrixHttpRemote } from "./providerMatrixHttpRemote";
import type { ProviderMatrixObservation } from "./providerMatrixTypes";
import {
  REQUIRED_CONTEXTS,
  REQUIRED_OPERATIONS,
  REQUIRED_ORIGINS,
} from "./providerMatrixTypes";

type StandaloneFactory = (config: unknown) => StoragePlugin;
type StandaloneModule = Readonly<{
  standaloneStorage: StandaloneFactory;
}>;

const isStandaloneModule = (value: unknown): value is StandaloneModule =>
  typeof value === "object" &&
  value !== null &&
  "standaloneStorage" in value &&
  typeof value.standaloneStorage === "function";

const observeStandaloneEntry = async (
  id: "standalone-neutral" | "standalone-node",
  entry: string,
  targets: readonly ("node" | "worker" | "functions" | "edge")[],
  factory: StandaloneFactory,
): Promise<ProviderMatrixObservation> => {
  const remoteA = createProviderMatrixHttpRemote("A");
  const remoteB = createProviderMatrixHttpRemote("B");
  const remoteContext = createStorageOperationContext({
    target: "node",
    environment: {},
    bindings: {},
  });
  const handlers = {
    "a.example": createStandaloneStorageHandler({
      storage: remoteA,
      context: remoteContext,
    }),
    "b.example": createStandaloneStorageHandler({
      storage: remoteB,
      context: remoteContext,
    }),
    "literal.example": createStandaloneStorageHandler({
      storage: remoteA,
      context: remoteContext,
    }),
  };
  const requests: Array<
    Readonly<{
      contextId: string | null;
      host: string;
      method: string;
      origin: string;
    }>
  > = [];
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      requests.push({
        contextId: request.headers.get("x-context-id"),
        host: url.host,
        method: request.method,
        origin:
          request.headers.get("authorization") === "Bearer token-a"
            ? "A"
            : request.headers.get("authorization") === "Bearer token-b"
              ? "B"
              : "literal",
      });
      const handler =
        url.host === "a.example"
          ? handlers["a.example"]
          : url.host === "b.example"
            ? handlers["b.example"]
            : url.host === "literal.example"
              ? handlers["literal.example"]
              : undefined;
      return (await handler?.(request)) ?? new Response(null, { status: 404 });
    },
  );
  try {
    const tagged = factory({
      baseUrl: env("URL"),
      commonHeaders: {
        authorization: secret("TOKEN"),
        "x-context-id": env("REQUEST_ID"),
      },
    });
    const contexts = REQUIRED_CONTEXTS.map((requestId, index) =>
      createStorageOperationContext({
        target: targets[index % targets.length] ?? "node",
        environment: {
          REQUEST_ID: requestId,
          URL: `https://${REQUIRED_ORIGINS[index].toLowerCase()}.example`,
          TOKEN: `Bearer token-${REQUIRED_ORIGINS[index].toLowerCase()}`,
        },
        bindings: {},
      }),
    );
    const stored = await Promise.all(
      contexts.map((context, index) =>
        tagged.put({
          context,
          key: `${REQUIRED_ORIGINS[index]}-${index}`,
          body: new Uint8Array([index + 1]),
          contentLength: 1,
        }),
      ),
    );
    const firstUri = stored[0]?.storageUri ?? "";
    await tagged.head({ context: contexts[0], storageUri: firstUri });
    const found = await tagged.get({
      context: contexts[0],
      storageUri: firstUri,
      range: { start: 0, end: 0 },
    });
    if (found.kind === "found") {
      await new Response(found.body).arrayBuffer();
    }
    await tagged.delete({ context: contexts[0], storageUri: firstUri });
    const taggedRequests = requests.slice();

    const literal = factory({
      baseUrl: "https://literal.example",
      commonHeaders: { authorization: "Bearer literal" },
    });
    await literal.head({
      context: contexts[0],
      storageUri: "http://remote.invalid/A/missing-1",
    });
    await literal.head({
      context: contexts[0],
      storageUri: "http://remote.invalid/A/missing-2",
    });

    return {
      id,
      entry,
      targets,
      contexts: REQUIRED_CONTEXTS,
      operations: REQUIRED_OPERATIONS,
      origins: REQUIRED_ORIGINS,
      providerVisible: {
        endpointOrigins: taggedRequests
          .filter(({ method }) => method === "PUT")
          .map(({ host }) => (host.startsWith("a.") ? "A" : "B")),
        headerOrigins: taggedRequests
          .filter(({ method }) => method === "PUT")
          .map(({ origin }) => origin),
        providerContextIds: taggedRequests
          .filter(({ method }) => method === "PUT")
          .map(({ contextId }) => contextId ?? "missing"),
        remoteARequests: taggedRequests.filter(({ host }) =>
          host.startsWith("a."),
        ).length,
        remoteBRequests: taggedRequests.filter(({ host }) =>
          host.startsWith("b."),
        ).length,
        literalRequests: requests.length - taggedRequests.length,
        streamed: found.kind === "found",
      },
      cache: { literal: "allowed", tagged: "forbidden" },
      streamLifetime: "response-owned",
      secretCanaryLeaked: false,
    };
  } finally {
    vi.unstubAllGlobals();
  }
};

export const observeStandaloneMatrix = async (): Promise<
  readonly ProviderMatrixObservation[]
> => {
  const neutralUrl = new URL(
    "../../../../plugins/standalone/src/storage.ts",
    import.meta.url,
  ).href;
  const nodeUrl = new URL(
    "../../../../plugins/standalone/src/storage/node.ts",
    import.meta.url,
  ).href;
  const [neutralModule, nodeModule]: unknown[] = await Promise.all([
    import(neutralUrl),
    import(nodeUrl),
  ]);
  if (!isStandaloneModule(neutralModule) || !isStandaloneModule(nodeModule)) {
    throw new TypeError("Standalone public storage entry is invalid.");
  }
  const neutral = await observeStandaloneEntry(
    "standalone-neutral",
    "@hot-updater/standalone/storage",
    ["node", "worker", "functions", "edge"],
    neutralModule.standaloneStorage,
  );
  const node = await observeStandaloneEntry(
    "standalone-node",
    "@hot-updater/standalone/storage/node",
    ["node"],
    nodeModule.standaloneStorage,
  );
  return [neutral, node];
};
