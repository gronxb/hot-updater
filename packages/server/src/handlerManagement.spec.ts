import type { Deployment } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import {
  createAdminHandler,
  createApi,
  testBundle,
} from "./handler.testFixtures";

const BASE = "http://localhost";

const send = (method: string, path: string, body?: unknown) =>
  new Request(`${BASE}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
  });

const deployment = (id: string, channel = "production"): Deployment => ({
  bundle: { ...testBundle, id },
  release: {
    channel,
    enabled: false,
    fingerprintHash: null,
    message: null,
    shouldForceUpdate: false,
    targetAppVersion: "1.0.x",
  },
});

const BUNDLE_A = "01900000-0000-7000-8000-000000000001";
const BUNDLE_B = "01900000-0000-7000-8000-000000000002";

describe("admin routes on core", () => {
  it("does not match client routes", async () => {
    const handler = createAdminHandler();
    const response = await handler(
      send("GET", `/artifacts/v1/${BUNDLE_B}/from/${BUNDLE_A}`),
    );

    expect(response.status).toBe(404);
  });

  it("reports the admin API protocol where standalone clients call", async () => {
    const handler = createAdminHandler();
    const response = await handler(send("GET", "/version"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      adminProtocol: 2,
    });
  });

  it.each([
    ["POST", "/database/commit"],
    ["POST", "/bundles"],
    ["DELETE", `/bundles/${BUNDLE_A}`],
  ])("no longer serves protocol 1's %s %s", async (method, path) => {
    const handler = createAdminHandler();

    const response = await handler(send(method, path, {}));

    expect(response.status).toBe(404);
  });

  it("creates, finds, lists, and deletes a channel, with or without v=2", async () => {
    const handler = createAdminHandler();

    const created = await handler(
      send("POST", "/channels", { name: "preview" }),
    );
    const again = await handler(
      send("POST", "/channels?v=2", { name: "preview" }),
    );
    const { data: channel } = (await created.json()) as {
      data: { id: string; name: string };
    };
    const found = await handler(send("GET", "/channels?name=preview"));
    const listed = await handler(send("GET", "/channels?v=2"));

    expect(created.status).toBe(200);
    expect(channel.name).toBe("preview");
    await expect(again.json()).resolves.toEqual({ data: channel });
    await expect(found.json()).resolves.toEqual({ data: channel });
    await expect(listed.json()).resolves.toEqual({ data: [channel] });

    const deleted = await handler(send("DELETE", `/channels/${channel.id}`));
    const missing = await handler(send("DELETE", `/channels/${channel.id}`));

    expect(deleted.status).toBe(204);
    await expect(deleted.text()).resolves.toBe("");
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({
      data: { deleted: false, reason: "not_found" },
    });
  });

  it("refuses to delete a channel a release uses", async () => {
    const api = createApi();
    await api.core.deploy([deployment(BUNDLE_A)]);
    const channel = await api.core.findChannelByName("production");
    const handler = createAdminHandler(api);

    const response = await handler(send("DELETE", `/channels/${channel!.id}`));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      data: { deleted: false, reason: "not_empty" },
    });
  });

  it("pages bundles by key, newest first", async () => {
    const api = createApi();
    await api.core.deploy([deployment(BUNDLE_A)]);
    await api.core.deploy([deployment(BUNDLE_B)]);
    const handler = createAdminHandler(api);

    const first = await handler(send("GET", "/bundles?limit=1&total=true"));
    const firstPage = (await first.json()) as {
      data: { bundle: { id: string } }[];
      next: string;
      total: number;
    };
    const second = await handler(
      send("GET", `/bundles?limit=1&cursor=${firstPage.next}`),
    );
    const secondPage = (await second.json()) as {
      data: { bundle: { id: string } }[];
    };

    expect(firstPage.data.map(({ bundle }) => bundle.id)).toEqual([BUNDLE_B]);
    expect(firstPage.total).toBe(2);
    expect(secondPage.data.map(({ bundle }) => bundle.id)).toEqual([BUNDLE_A]);
  });

  it.each(["limit=101", "order=random", "platform=web"])(
    "refuses the bundle list query %s",
    async (query) => {
      const handler = createAdminHandler();

      const response = await handler(send("GET", `/bundles?${query}`));

      expect(response.status).toBe(400);
    },
  );

  it("changes a bundle's fields and refuses another bundle's id", async () => {
    const api = createApi();
    await api.core.deploy([deployment(BUNDLE_A)]);
    const handler = createAdminHandler(api);

    const updated = await handler(
      send("PATCH", `/bundles/${BUNDLE_A}`, { gitCommitHash: "abc123" }),
    );
    const mismatch = await handler(
      send("PATCH", `/bundles/${BUNDLE_A}`, { id: BUNDLE_B }),
    );

    expect(updated.status).toBe(204);
    expect((await api.core.getBundle(BUNDLE_A))?.bundle.git_commit_hash).toBe(
      "abc123",
    );
    expect(mismatch.status).toBe(400);
  });

  it("hard-deletes a disabled release only when confirm names it", async () => {
    const api = createApi();
    const [result] = await api.core.deploy([deployment(BUNDLE_A)]);
    const releaseId = result!.release!.id;
    const handler = createAdminHandler(api);

    const unconfirmed = await handler(send("DELETE", `/releases/${releaseId}`));
    const deleted = await handler(
      send("DELETE", `/releases/${releaseId}?confirm=${releaseId}`),
    );

    expect(unconfirmed.status).toBe(400);
    expect(deleted.status).toBe(200);
    await expect(api.core.getRelease(releaseId)).resolves.toBeNull();
  });
});
