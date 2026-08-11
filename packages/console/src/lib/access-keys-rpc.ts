import type { ClientAccessKeyRow } from "@hot-updater/plugin-core";
import { createClientAccessKey } from "@hot-updater/server";
import { createServerFn } from "@tanstack/react-start";

export type ClientAccessKeyView = Omit<ClientAccessKeyRow, "hash">;

export const toClientAccessKeyView = ({
  hash: _hash,
  ...record
}: ClientAccessKeyRow): ClientAccessKeyView => record;

const parseName = (input: unknown): { readonly name: string } => {
  const name =
    typeof input === "object" && input !== null
      ? Reflect.get(input, "name")
      : undefined;
  if (typeof name !== "string") {
    throw new TypeError("Access-key name must be a string.");
  }
  return { name };
};

const parseId = (input: unknown): { readonly id: string } => {
  const id =
    typeof input === "object" && input !== null
      ? Reflect.get(input, "id")
      : undefined;
  if (typeof id !== "string" || !/^client-[A-Za-z0-9_-]{43}$/u.test(id)) {
    throw new TypeError("Invalid client access-key id.");
  }
  return { id };
};

const requireStore = async () => {
  const { prepareConfig } = await import("./server/config.server");
  const { clientAccessKeyStore } = await prepareConfig();
  if (clientAccessKeyStore === null) {
    throw new Error(
      "Access keys are not supported by the configured database plugin.",
    );
  }
  return clientAccessKeyStore;
};

export const getClientAccessKeyCapabilityRpc = createServerFn({
  method: "GET",
}).handler(async () => {
  const { prepareConfig } = await import("./server/config.server");
  const { clientAccessKeyStore } = await prepareConfig();
  return { accessKeys: clientAccessKeyStore !== null } as const;
});

export const listClientAccessKeysRpc = createServerFn({
  method: "GET",
}).handler(async () => {
  const store = await requireStore();
  const records = await store.list();
  return [...records]
    .sort((left, right) => right.created_at_ms - left.created_at_ms)
    .map(toClientAccessKeyView);
});

export const createClientAccessKeyRpc = createServerFn({ method: "POST" })
  .validator(parseName)
  .handler(async ({ data }) => {
    const store = await requireStore();
    const created = await createClientAccessKey({
      clientAccessKeys: store,
      name: data.name,
    });
    return {
      apiKey: created.apiKey,
      record: toClientAccessKeyView(created.record),
    };
  });

export const revokeClientAccessKeyRpc = createServerFn({ method: "POST" })
  .validator(parseId)
  .handler(async ({ data }) => {
    const store = await requireStore();
    const revoked = await store.revoke({
      id: data.id,
      revokedAtMs: Date.now(),
    });
    if (revoked === null) throw new Error("Access key not found.");
    return toClientAccessKeyView(revoked);
  });
