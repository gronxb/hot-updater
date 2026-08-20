import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { describe, expect, it } from "vitest";

import { createInMemoryDatabasePlugin } from "../../test-utils/test/inMemoryDatabasePlugin";
import { createHotUpdater } from "./index";

describe("framework-owned admin authentication", () => {
  it("protects admin without affecting the client handler", async () => {
    const hotUpdater = createHotUpdater({
      database: createInMemoryDatabasePlugin(),
    });
    const adminToken = "test-management-token";
    const app = new Hono();
    app.use("/hot-updater/admin/*", bearerAuth({ token: adminToken }));
    app.mount("/hot-updater/admin", hotUpdater.handlers.admin);
    app.mount("/hot-updater", hotUpdater.handlers.client);

    const clientResponse = await app.request("/hot-updater/version");
    const unauthorizedAdmin = await app.request("/hot-updater/admin/channels");
    const authorizedAdmin = await app.request("/hot-updater/admin/channels", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(clientResponse.status).toBe(200);
    expect(unauthorizedAdmin.status).toBe(401);
    expect(authorizedAdmin.status).toBe(200);
    expect(authorizedAdmin.headers.get("cache-control")).toBe(
      "private, no-store",
    );
  });
});
