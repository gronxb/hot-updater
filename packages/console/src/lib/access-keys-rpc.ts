import type { ManagedAccessKeyRecord } from "@hot-updater/better-auth/managed";
import { createServerFn } from "@tanstack/react-start";

export type ManagedAccessKeyView = Omit<ManagedAccessKeyRecord, "hash">;

export const toManagedAccessKeyView = ({
  hash: _hash,
  ...record
}: ManagedAccessKeyRecord): ManagedAccessKeyView => record;

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
  if (
    typeof id !== "string" ||
    !/^managed-client-[A-Za-z0-9_-]{43}$/u.test(id)
  ) {
    throw new TypeError("Invalid managed access-key id.");
  }
  return { id };
};

const requireStore = async () => {
  const { prepareConfig } = await import("./server/config.server");
  const { managedAccessKeyStore } = await prepareConfig();
  if (managedAccessKeyStore === null) {
    throw new Error(
      "Access keys are not supported by the configured database plugin.",
    );
  }
  return managedAccessKeyStore;
};

export const getManagedAccessKeyCapabilityRpc = createServerFn({
  method: "GET",
}).handler(async () => {
  const { prepareConfig } = await import("./server/config.server");
  const { managedAccessKeyStore } = await prepareConfig();
  return { accessKeys: managedAccessKeyStore !== null } as const;
});

export const listManagedAccessKeysRpc = createServerFn({
  method: "GET",
}).handler(async () => {
  const store = await requireStore();
  const records = await store.list();
  return [...records]
    .sort((left, right) => right.createdAt - left.createdAt)
    .map(toManagedAccessKeyView);
});

export const createManagedAccessKeyRpc = createServerFn({ method: "POST" })
  .validator(parseName)
  .handler(async ({ data }) => {
    const store = await requireStore();
    const { createManagedBetterAuthApiKey } =
      await import("@hot-updater/better-auth/managed/provisioning");
    const created = await createManagedBetterAuthApiKey({
      name: data.name,
      store,
    });
    return {
      apiKey: created.apiKey,
      record: toManagedAccessKeyView(created.record),
    };
  });

export const revokeManagedAccessKeyRpc = createServerFn({ method: "POST" })
  .validator(parseId)
  .handler(async ({ data }) => {
    const store = await requireStore();
    const revoked = await store.revoke({ id: data.id, revokedAt: Date.now() });
    if (revoked === null) throw new Error("Access key not found.");
    return toManagedAccessKeyView(revoked);
  });
