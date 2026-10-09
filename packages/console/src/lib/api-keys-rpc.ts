import type { ApiKeyRow } from "@hot-updater/server/plugins";
import { createServerFn } from "@tanstack/react-start";

import { consoleAccess } from "./console-access";

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

/** API key management, once the console's access check and the feature guard pass. */
const apiKeyManagement = async () => {
  const [{ prepareConfig }, { requireFeature }] = await Promise.all([
    import("./server/config.server"),
    import("./server/runtime.server"),
  ]);
  const { runtime } = await prepareConfig();
  return requireFeature(runtime, "apiKeys");
};

export const listApiKeysRpc = createServerFn({
  method: "GET",
})
  .middleware([consoleAccess])
  .handler(async (): Promise<ApiKeyView[]> => {
    const apiKeys = await apiKeyManagement();
    return [...(await apiKeys.list())].sort(
      (left, right) => right.created_at_ms - left.created_at_ms,
    );
  });

export const createApiKeyRpc = createServerFn({ method: "POST" })
  .middleware([consoleAccess])
  .validator(parseName)
  .handler(async ({ data }) => {
    const apiKeys = await apiKeyManagement();
    const created = await apiKeys.create({ name: data.name });
    return {
      apiKey: created.apiKey,
      record: created.record,
    };
  });

export const revokeApiKeyRpc = createServerFn({ method: "POST" })
  .middleware([consoleAccess])
  .validator(parseId)
  .handler(async ({ data }): Promise<ApiKeyView> => {
    const apiKeys = await apiKeyManagement();
    const revoked = await apiKeys.revoke({ id: data.id });
    if (revoked === null) throw new Error("API key not found.");
    return revoked;
  });
