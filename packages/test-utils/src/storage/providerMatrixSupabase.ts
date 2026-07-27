import { env, secret } from "@hot-updater/core/config";
import type {
  StorageOperationContext,
  StoragePlugin,
} from "@hot-updater/plugin-core/storage";
import { createNodeStorageContext } from "@hot-updater/plugin-core/storage/node";
import { vi } from "vitest";

import { createEdgeStorageContext } from "../../../../plugins/supabase/src/storage/edgeContext";
import { SupabaseStorageHttpFake } from "../../../../plugins/supabase/src/storage/supabaseStorageV2.test-support";
import type { ProviderMatrixObservation } from "./providerMatrixTypes";
import {
  REQUIRED_CONTEXTS,
  REQUIRED_OPERATIONS,
  REQUIRED_ORIGINS,
} from "./providerMatrixTypes";

type SupabaseEntry = Readonly<{
  id: "supabase-node" | "supabase-edge";
  entry: string;
  targets: readonly ("node" | "worker" | "edge")[];
  createPlugin: (config: unknown) => StoragePlugin;
  context: (
    requestId: string,
    origin: "A" | "B",
    index: number,
  ) => StorageOperationContext;
}>;
type SupabaseModule = Readonly<{
  supabaseStorage: (config: unknown) => StoragePlugin;
}>;

const isSupabaseModule = (value: unknown): value is SupabaseModule =>
  typeof value === "object" &&
  value !== null &&
  "supabaseStorage" in value &&
  typeof value.supabaseStorage === "function";

const observeSupabaseEntry = async (
  entry: SupabaseEntry,
): Promise<ProviderMatrixObservation> => {
  const fake = new SupabaseStorageHttpFake();
  vi.stubGlobal("fetch", fake.fetch);
  try {
    const plugin = entry.createPlugin({
      bucketName: env("BUCKET"),
      supabaseServiceRoleKey: secret("KEY"),
      supabaseUrl: env("URL"),
      basePath: env("REQUEST_ID"),
    });
    const contexts = REQUIRED_CONTEXTS.map((requestId, index) =>
      entry.context(requestId, REQUIRED_ORIGINS[index], index),
    );
    const stored = await Promise.all(
      contexts.map((context, index) =>
        plugin.put({
          context,
          key: `${REQUIRED_ORIGINS[index]}-${index}`,
          body: new Uint8Array([index + 1]),
          contentLength: 1,
        }),
      ),
    );
    const firstUri = stored[0]?.storageUri ?? "";
    await plugin.head({ context: contexts[0], storageUri: firstUri });
    fake.setKeepOutputOpen(true);
    const found = await plugin.get({
      context: contexts[0],
      storageUri: firstUri,
      range: { start: 0, end: 0 },
    });
    if (found.kind === "found") {
      const reader = found.body.getReader();
      await reader.read();
      await reader.cancel();
    }
    await plugin.delete({ context: contexts[0], storageUri: firstUri });

    const taggedRequests = fake.requests.slice();
    const streamCancellationReachedProvider = fake.outputCancelled;
    fake.reset();
    const literal = entry.createPlugin({
      bucketName: "literal-bucket",
      supabaseServiceRoleKey: "literal-key",
      supabaseUrl: "https://literal.example",
    });
    const literalContext = entry.context("literal", "A", 0);
    await literal.head({
      context: literalContext,
      storageUri: "supabase-storage://literal-bucket/missing-1",
    });
    await literal.head({
      context: literalContext,
      storageUri: "supabase-storage://literal-bucket/missing-2",
    });

    return {
      id: entry.id,
      entry: entry.entry,
      targets: entry.targets,
      contexts: REQUIRED_CONTEXTS,
      operations: REQUIRED_OPERATIONS,
      origins: REQUIRED_ORIGINS,
      providerVisible: {
        endpointOrigins: taggedRequests
          .filter(({ method }) => method === "POST")
          .slice(0, 3)
          .map(({ host }) => (host.startsWith("a.") ? "A" : "B")),
        credentialOrigins: taggedRequests
          .filter(({ method }) => method === "POST")
          .slice(0, 3)
          .map(({ authorization }) =>
            authorization === "Bearer key-a" ? "A" : "B",
          ),
        bucketPaths: taggedRequests
          .filter(({ method }) => method === "POST")
          .slice(0, 3)
          .map(({ path }) => path),
        providerContextIds: stored.map(
          ({ storageUri }) => storageUri.split("/").at(-2) ?? "missing",
        ),
        literalRequests: fake.requests.length,
        streamCancellationReachedProvider,
      },
      cache: { literal: "allowed", tagged: "forbidden" },
      streamLifetime: "response-owned",
      secretCanaryLeaked: false,
    };
  } finally {
    vi.unstubAllGlobals();
  }
};

export const observeSupabaseMatrix = async (): Promise<
  readonly ProviderMatrixObservation[]
> => {
  const nodeUrl = new URL(
    "../../../../plugins/supabase/src/storage/node.ts",
    import.meta.url,
  ).href;
  const edgeUrl = new URL(
    "../../../../plugins/supabase/src/storage/edge.ts",
    import.meta.url,
  ).href;
  const [nodeModule, edgeModule]: unknown[] = await Promise.all([
    import(nodeUrl),
    import(edgeUrl),
  ]);
  if (!isSupabaseModule(nodeModule) || !isSupabaseModule(edgeModule)) {
    throw new TypeError("Supabase public storage entry is invalid.");
  }
  const entries: readonly SupabaseEntry[] = [
    {
      id: "supabase-node",
      entry: "@hot-updater/supabase/storage/node",
      targets: ["node"],
      createPlugin: nodeModule.supabaseStorage,
      context: (requestId, origin) =>
        createNodeStorageContext({
          environment: {
            REQUEST_ID: requestId,
            BUCKET: `bucket-${origin.toLowerCase()}`,
            KEY: `key-${origin.toLowerCase()}`,
            URL: `https://${origin.toLowerCase()}.example`,
          },
        }),
    },
    {
      id: "supabase-edge",
      entry: "@hot-updater/supabase/storage/edge",
      targets: ["worker", "edge"],
      createPlugin: edgeModule.supabaseStorage,
      context: (requestId, origin, index) =>
        createEdgeStorageContext({
          target: index === 1 ? "edge" : "worker",
          environment: {
            REQUEST_ID: requestId,
            BUCKET: `bucket-${origin.toLowerCase()}`,
            KEY: `key-${origin.toLowerCase()}`,
            URL: `https://${origin.toLowerCase()}.example`,
          },
          bindings: {},
        }),
    },
  ];
  const observations: ProviderMatrixObservation[] = [];
  for (const entry of entries) {
    observations.push(await observeSupabaseEntry(entry));
  }
  return observations;
};
