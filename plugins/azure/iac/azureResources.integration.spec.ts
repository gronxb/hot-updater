import { BlobServiceClient } from "@azure/storage-blob";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startAzurite } from "../test-utils/azureEmulators";
import { ensurePrivateContainer } from "./azureResources";

let azurite: Awaited<ReturnType<typeof startAzurite>> | undefined;

beforeAll(async () => {
  azurite = await startAzurite();
}, 180_000);

afterAll(async () => {
  await azurite?.stop();
});

const container = (name: string) =>
  BlobServiceClient.fromConnectionString(
    azurite!.connectionString,
  ).getContainerClient(name);

describe("ensurePrivateContainer (Azurite)", () => {
  it("creates the container private", async () => {
    const created = container("created");
    await ensurePrivateContainer(created);
    expect((await created.getAccessPolicy()).blobPublicAccess).toBeUndefined();
  });

  it("makes a reused public container private and keeps its stored access policies", async () => {
    const reused = container("reused");
    const signedIdentifiers = [
      {
        id: "existing",
        accessPolicy: {
          permissions: "r",
          startsOn: new Date("2026-01-01T00:00:00Z"),
          expiresOn: new Date("2027-01-01T00:00:00Z"),
        },
      },
    ];
    await reused.create({ access: "blob" });
    await reused.setAccessPolicy("blob", signedIdentifiers);

    await ensurePrivateContainer(reused);

    const policy = await reused.getAccessPolicy();
    expect(policy.blobPublicAccess).toBeUndefined();
    expect(policy.signedIdentifiers.map(({ id }) => id)).toEqual(["existing"]);
  });

  it("leaves a reused private container as it is", async () => {
    const reused = container("private");
    await reused.create();
    await ensurePrivateContainer(reused);
    expect((await reused.getAccessPolicy()).blobPublicAccess).toBeUndefined();
  });
});
