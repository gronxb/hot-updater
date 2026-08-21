import type { ApiKeyRow } from "@hot-updater/plugin-core";
import { createApiKey } from "@hot-updater/server";
import { createServerFn } from "@tanstack/react-start";

export type ApiKeyView = Omit<ApiKeyRow, "hash">;

export const toApiKeyView = ({
  hash: _hash,
  ...record
}: ApiKeyRow): ApiKeyView => record;

const parseName = (input: unknown): { readonly name: string } => {
  const name =
    typeof input === "object" && input !== null
      ? Reflect.get(input, "name")
      : undefined;
  if (typeof name !== "string") {
    throw new TypeError("API key name must be a string.");
  }
  return { name };
};

const parseId = (input: unknown): { readonly id: string } => {
  const id =
    typeof input === "object" && input !== null
      ? Reflect.get(input, "id")
      : undefined;
  if (typeof id !== "string" || !/^api-[A-Za-z0-9_-]{43}$/u.test(id)) {
    throw new TypeError("Invalid API key id.");
  }
  return { id };
};

const requireStore = async () => {
  const { prepareConfig } = await import("./server/config.server");
  const { apiKeyStore } = await prepareConfig();
  if (apiKeyStore === null) {
    throw new Error(
      "API keys are not supported by the configured database plugin.",
    );
  }
  return apiKeyStore;
};

export const getApiKeyCapabilityRpc = createServerFn({
  method: "GET",
}).handler(async () => {
  const { prepareConfig } = await import("./server/config.server");
  const { apiKeyStore } = await prepareConfig();
  return { apiKeys: apiKeyStore !== null } as const;
});

export const listApiKeysRpc = createServerFn({
  method: "GET",
}).handler(async () => {
  const store = await requireStore();
  const records = await store.list();
  return [...records]
    .sort((left, right) => right.created_at_ms - left.created_at_ms)
    .map(toApiKeyView);
});

export const createApiKeyRpc = createServerFn({ method: "POST" })
  .validator(parseName)
  .handler(async ({ data }) => {
    const store = await requireStore();
    const created = await createApiKey({
      apiKeys: store,
      name: data.name,
    });
    return {
      apiKey: created.apiKey,
      record: created.record,
    };
  });

export const revokeApiKeyRpc = createServerFn({ method: "POST" })
  .validator(parseId)
  .handler(async ({ data }) => {
    const store = await requireStore();
    const revoked = await store.revoke({
      id: data.id,
      revokedAtMs: Date.now(),
    });
    if (revoked === null) throw new Error("API key not found.");
    return toApiKeyView(revoked);
  });
