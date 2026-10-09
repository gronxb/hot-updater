import { describe, expect, it } from "vitest";

import { createRemoteConfigAdminApi } from "./admin";
import { RemoteConfigValidationError } from "./template";

const answering =
  (status: number, body: unknown) =>
  async (_path: string, _init?: RequestInit) =>
    Response.json(body, { status });

const PUBLISH = { template: {}, baseVersion: 1 } as const;

describe("createRemoteConfigAdminApi", () => {
  it("publishes when the server answers the version it published", async () => {
    const version = {
      version: 2,
      description: null,
      updateType: "PUBLISH",
      rollbackSource: null,
      createdAtMs: 1_000,
    };
    await expect(
      createRemoteConfigAdminApi(answering(200, version)).publish(PUBLISH),
    ).resolves.toEqual({ status: "published", version });
  });

  it("refuses any other success, such as the active template a GET answers", async () => {
    const active = { version: 1, template: {}, updatedAtMs: 1_000 };
    await expect(
      createRemoteConfigAdminApi(answering(200, active)).publish(PUBLISH),
    ).rejects.toThrow("without the version it published");
    await expect(
      createRemoteConfigAdminApi(answering(200, active)).rollback({
        version: 1,
        baseVersion: 1,
      }),
    ).rejects.toThrow("without the version it published");
  });

  it("answers a conflict, and throws a template's issues as the API does", async () => {
    await expect(
      createRemoteConfigAdminApi(
        answering(409, { error: "Version 3 was published", currentVersion: 3 }),
      ).publish(PUBLISH),
    ).resolves.toEqual({ status: "conflict", currentVersion: 3 });
    const issues = [{ path: "parameters.x", message: "must be an object." }];
    const invalid = createRemoteConfigAdminApi(
      answering(400, { error: "invalid", issues }),
    ).publish(PUBLISH);
    await expect(invalid).rejects.toBeInstanceOf(RemoteConfigValidationError);
    await expect(invalid).rejects.toMatchObject({ issues });
    await expect(
      createRemoteConfigAdminApi(
        answering(400, {
          error: "baseVersion must be a non-negative integer.",
        }),
      ).publish(PUBLISH),
    ).rejects.toThrow("baseVersion must be a non-negative integer.");
  });

  it("answers a version the server does not have as null, or not_found for a rollback", async () => {
    const missing = answering(404, { error: "Version not found" });
    await expect(
      createRemoteConfigAdminApi(missing).getVersion(9),
    ).resolves.toBe(null);
    await expect(
      createRemoteConfigAdminApi(missing).rollback({
        version: 9,
        baseVersion: 1,
      }),
    ).resolves.toEqual({ status: "not_found" });
  });

  it("throws the caller's error when the server runs without remoteConfig()", async () => {
    const coreNotFound = answering(404, { error: "Not found" });
    await expect(
      createRemoteConfigAdminApi(coreNotFound).getActive(),
    ).rejects.toThrow("The server runs without remoteConfig()");
    const unavailable = new Error("Not on this server");
    await expect(
      createRemoteConfigAdminApi(coreNotFound, {
        unavailable: () => unavailable,
      }).listVersions(),
    ).rejects.toBe(unavailable);
  });
});
