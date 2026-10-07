// @vitest-environment node

import { describe, expect, it } from "vitest";

import { createAdminRemoteConfig } from "./remoteConfig";

const answering =
  (status: number, body: unknown) =>
  async (_path: string, _init?: RequestInit) =>
    Response.json(body, { status });

const PUBLISH = { template: {}, baseVersion: 1 } as const;

describe("createAdminRemoteConfig", () => {
  it("publishes when the server answers the version it published", async () => {
    const version = {
      version: 2,
      description: null,
      updateType: "PUBLISH",
      rollbackSource: null,
      createdAtMs: 1_000,
    };
    await expect(
      createAdminRemoteConfig(answering(200, version)).publish(PUBLISH),
    ).resolves.toEqual({ status: "published", version });
  });

  it("refuses any other success, such as the active template a GET answers", async () => {
    const active = { version: 1, template: {}, updatedAtMs: 1_000 };
    await expect(
      createAdminRemoteConfig(answering(200, active)).publish(PUBLISH),
    ).rejects.toThrow("without the version it published");
    await expect(
      createAdminRemoteConfig(answering(200, active)).rollback({
        version: 1,
        baseVersion: 1,
      }),
    ).rejects.toThrow("without the version it published");
  });

  it("reads a conflict and a template's issues from the server's answer", async () => {
    await expect(
      createAdminRemoteConfig(
        answering(409, { error: "Version 3 was published", currentVersion: 3 }),
      ).publish(PUBLISH),
    ).resolves.toEqual({ status: "conflict", currentVersion: 3 });
    const issues = [{ path: "parameters.x", message: "must be an object." }];
    await expect(
      createAdminRemoteConfig(
        answering(400, { error: "invalid", issues }),
      ).publish(PUBLISH),
    ).resolves.toEqual({ status: "invalid", issues });
    await expect(
      createAdminRemoteConfig(
        answering(400, {
          error: "baseVersion must be a non-negative integer.",
        }),
      ).publish(PUBLISH),
    ).rejects.toThrow("baseVersion must be a non-negative integer.");
  });
});
