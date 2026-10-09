// @vitest-environment node

import { describe, expect, it } from "vitest";

import { ConsoleFeatureUnavailableError } from "../console-features";
import { createAdminRemoteConfig } from "./remoteConfig";

const answering =
  (status: number, body: unknown) =>
  async (_path: string, _init?: RequestInit) =>
    Response.json(body, { status });

const PUBLISH = { template: {}, baseVersion: 1 } as const;

describe("createAdminRemoteConfig", () => {
  it("answers a template's issues as a result the publish dialog lists", async () => {
    const issues = [{ path: "parameters.x", message: "must be an object." }];
    await expect(
      createAdminRemoteConfig(
        answering(400, { error: "invalid", issues }),
      ).publish(PUBLISH),
    ).resolves.toEqual({ status: "invalid", issues });
  });

  it("marks Remote Config unavailable on a server that runs without remoteConfig()", async () => {
    await expect(
      createAdminRemoteConfig(
        answering(404, { error: "Not found" }),
      ).getActive(),
    ).rejects.toBeInstanceOf(ConsoleFeatureUnavailableError);
  });
});
