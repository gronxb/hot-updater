import { Hono } from "hono";
import { api } from "./db";
import type { GetBundlesArgs, Bundle } from "@hot-updater/core";

const app = new Hono();

// POST /api/update - Client checks for updates
app.post("/api/update", async (c) => {
  try {
    const body = await c.req.json<GetBundlesArgs>();

    const updateInfo = await api.getAppUpdateInfo(body);

    if (!updateInfo) {
      return c.json({ update: false });
    }

    return c.json({
      update: true,
      ...updateInfo,
    });
  } catch (error) {
    console.error("Error checking for updates:", error);
    return c.json(
      { error: "Failed to check for updates" },
      500,
    );
  }
});

// GET /api/bundles - List bundles
app.get("/api/bundles", async (c) => {
  try {
    const channel = c.req.query("channel");
    const platform = c.req.query("platform");
    const limit = Number(c.req.query("limit")) || 50;

    const bundles = await api.getBundles({
      where: {
        ...(channel && { channel }),
        ...(platform && { platform }),
      },
      limit,
    });

    return c.json({ bundles });
  } catch (error) {
    console.error("Error fetching bundles:", error);
    return c.json(
      { error: "Failed to fetch bundles" },
      500,
    );
  }
});

// POST /api/bundles - Create new bundle
app.post("/api/bundles", async (c) => {
  try {
    const bundle = await c.req.json<Bundle>();

    await api.insertBundle(bundle);

    return c.json({ success: true, bundle }, 201);
  } catch (error) {
    console.error("Error creating bundle:", error);
    return c.json(
      { error: "Failed to create bundle" },
      500,
    );
  }
});

// DELETE /api/bundles/:id - Delete bundle
app.delete("/api/bundles/:id", async (c) => {
  try {
    const id = c.req.param("id");

    await api.deleteBundle(id);

    return c.json({ success: true });
  } catch (error) {
    console.error("Error deleting bundle:", error);
    return c.json(
      { error: "Failed to delete bundle" },
      500,
    );
  }
});

// GET /api/channels - List all channels
app.get("/api/channels", async (c) => {
  try {
    const channels = await api.getChannels();

    return c.json({ channels });
  } catch (error) {
    console.error("Error fetching channels:", error);
    return c.json(
      { error: "Failed to fetch channels" },
      500,
    );
  }
});

export default app;
