import { describe, expect, it } from "vitest";

import type { RemoteConfigApi } from "./api";
import { createRemoteConfigEndpoints } from "./routes";

const fetchRoute = (resolve: RemoteConfigApi["resolve"]) => {
  const endpoint = createRemoteConfigEndpoints({
    resolve,
  } as RemoteConfigApi).find(({ path }) => path === "/remote-config")!;
  return endpoint.handler(
    new Request("https://updates.example.com/remote-config?platform=ios"),
    {},
  );
};

describe("Remote Config routes", () => {
  it("leaves a fault on the server's side to the host, never a 400", async () => {
    const fault = new TypeError(
      "Cannot read properties of undefined (reading 'conditions')",
    );
    await expect(
      fetchRoute(async () => {
        throw fault;
      }),
    ).rejects.toBe(fault);
  });

  it("answers a device context it cannot evaluate with 400", async () => {
    const endpoint = createRemoteConfigEndpoints({} as RemoteConfigApi).find(
      ({ path }) => path === "/remote-config",
    )!;
    const response = await endpoint.handler(
      new Request("https://updates.example.com/remote-config?platform=web"),
      {},
    );
    expect(response.status).toBe(400);
  });
});
