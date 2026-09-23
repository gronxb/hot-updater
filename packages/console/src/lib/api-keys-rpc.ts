import type { ApiKeyRow } from "@hot-updater/plugin-core";
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

const requireApiKeys = async () => {
  const { prepareConfig } = await import("./server/config.server");
  const { apiKeys } = await prepareConfig();
  if (apiKeys === null) {
    throw new Error(
      "API keys are not managed here: add apiKeys() to plugins, or manage a self-hosted server's keys with hot-updater keys on the server.",
    );
  }
  return apiKeys;
};

export const getApiKeyCapabilityRpc = createServerFn({
  method: "GET",
}).handler(async () => {
  const { prepareConfig } = await import("./server/config.server");
  const { apiKeys } = await prepareConfig();
  return { apiKeys: apiKeys !== null } as const;
});

export const listApiKeysRpc = createServerFn({
  method: "GET",
}).handler(async (): Promise<ApiKeyView[]> => {
  const apiKeys = await requireApiKeys();
  return [...(await apiKeys.list())].sort(
    (left, right) => right.created_at_ms - left.created_at_ms,
  );
});

export const createApiKeyRpc = createServerFn({ method: "POST" })
  .validator(parseName)
  .handler(async ({ data }) => {
    const apiKeys = await requireApiKeys();
    const created = await apiKeys.create({ name: data.name });
    return {
      apiKey: created.apiKey,
      record: created.record,
    };
  });

export const revokeApiKeyRpc = createServerFn({ method: "POST" })
  .validator(parseId)
  .handler(async ({ data }): Promise<ApiKeyView> => {
    const apiKeys = await requireApiKeys();
    const revoked = await apiKeys.revoke({ id: data.id });
    if (revoked === null) throw new Error("API key not found.");
    return revoked;
  });
