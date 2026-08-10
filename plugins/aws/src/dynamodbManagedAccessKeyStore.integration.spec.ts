import { registerManagedAccessKey } from "@hot-updater/better-auth/managed";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { DynamoDBIntegrationFixture } from "./dynamodbDatabase.integration-fixture";
import { createDynamoDBManagedAccessKeyStore } from "./dynamodbManagedAccessKeyStore";

const fixture = new DynamoDBIntegrationFixture();

beforeAll(() => fixture.start(), 120_000);
afterAll(() => fixture.stop());
beforeEach(() => fixture.reset());

describe("DynamoDB managed access-key store", () => {
  it("creates, lists, resolves, and atomically revokes access keys", async () => {
    const onRevoke = vi.fn();
    const store = createDynamoDBManagedAccessKeyStore(
      { client: fixture.client, tableName: fixture.tableName },
      { onRevoke },
    );
    const first = await registerManagedAccessKey({
      apiKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      createdAt: 1,
      name: "First",
      store,
    });
    const second = await registerManagedAccessKey({
      apiKey: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
      createdAt: 2,
      name: "Second",
      store,
    });

    await expect(store.list()).resolves.toEqual([second, first]);
    await expect(store.findByHash(first.hash)).resolves.toEqual(first);

    const revoked = await store.revoke({ id: first.id, revokedAt: 3 });
    expect(revoked).toEqual({ ...first, enabled: false, revokedAt: 3 });
    await expect(store.findByHash(first.hash)).resolves.toEqual(revoked);
    await expect(store.list()).resolves.toEqual([second, revoked]);
    await expect(store.revoke({ id: first.id, revokedAt: 4 })).resolves.toEqual(
      revoked,
    );
    expect(onRevoke).toHaveBeenCalledOnce();
  });
});
