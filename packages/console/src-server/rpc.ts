import { typiaValidator } from "@hono/typia-validator";
import {
  type Bundle,
  type ConfigResponse,
  type DatabasePlugin,
  type StoragePlugin,
  getCwd,
  loadConfig,
} from "@hot-updater/plugin-core";
import { Hono } from "hono";
import typia from "typia";

const DEFAULT_PAGE_LIMIT = 20;
const DEFAULT_PAGE_OFFSET = 0;

const queryBundlesSchema = typia.createValidate<{
  channel?: string;
  platform?: "ios" | "android";
  limit?: string;
  offset?: string;
}>();

const paramBundleIdSchema = typia.createValidate<{
  bundleId: string;
}>();

const updateBundleSchema = typia.createValidate<Partial<Bundle>>();

let configPromise: Promise<{
  config: ConfigResponse;
  databasePlugin: DatabasePlugin;
  storagePlugin: StoragePlugin;
}> | null = null;

const prepareConfig = async () => {
  if (!configPromise) {
    configPromise = (async () => {
      try {
        const config = await loadConfig(null);
        const databasePlugin =
          (await config?.database({ cwd: getCwd() })) ?? null;
        const storagePlugin =
          (await config?.storage({ cwd: getCwd() })) ?? null;
        if (!databasePlugin) {
          throw new Error("Database plugin initialization failed");
        }
        return { config, databasePlugin, storagePlugin };
      } catch (error) {
        console.error("Error during configuration initialization:", error);
        throw error;
      }
    })();
  }
  return configPromise;
};

export const rpc = new Hono()
  .get("/config", async (c) => {
    try {
      const { config } = await prepareConfig();
      return c.json({ console: config.console });
    } catch (error) {
      console.error("Error during config retrieval:", error);
      throw error;
    }
  })
  .get("/channels", async (c) => {
    try {
      const { databasePlugin } = await prepareConfig();
      const channels = await databasePlugin.getChannels();
      return c.json(channels ?? []);
    } catch (error) {
      console.error("Error during channel retrieval:", error);
      throw error;
    }
  })
  .get("/config-loaded", (c) => {
    try {
      const isLoaded = !!configPromise;
      return c.json({ configLoaded: isLoaded });
    } catch (error) {
      console.error("Error during config loaded retrieval:", error);
      throw error;
    }
  })
  .get("/bundles", typiaValidator("query", queryBundlesSchema), async (c) => {
    try {
      const rawQuery = c.req.valid("query");

      const query = {
        channel: rawQuery.channel ?? undefined,
        platform: rawQuery.platform ?? undefined,
        limit: rawQuery.limit ?? DEFAULT_PAGE_LIMIT,
        offset: rawQuery.offset ?? DEFAULT_PAGE_OFFSET,
      };

      const { databasePlugin } = await prepareConfig();
      const bundles = await databasePlugin.getBundles({
        where: {
          channel: query.channel,
          platform: query.platform,
        },
        limit: Number(query.limit),
        offset: Number(query.offset),
      });

      return c.json(bundles ?? []);
    } catch (error) {
      console.error("Error during bundle retrieval:", error);
      throw error;
    }
  })
  .get(
    "/bundles/:bundleId",
    typiaValidator("param", paramBundleIdSchema),
    async (c) => {
      try {
        const { bundleId } = c.req.valid("param");
        const { databasePlugin } = await prepareConfig();
        const bundle = await databasePlugin.getBundleById(bundleId);
        return c.json(bundle ?? null);
      } catch (error) {
        console.error("Error during bundle retrieval:", error);
        throw error;
      }
    },
  )
  .patch(
    "/bundles/:bundleId",
    typiaValidator("json", updateBundleSchema),
    async (c) => {
      try {
        const bundleId = c.req.param("bundleId");

        const partialBundle = c.req.valid("json");
        if (!bundleId) {
          return c.json({ error: "Target bundle ID is required" }, 400);
        }

        const { databasePlugin } = await prepareConfig();
        await databasePlugin.updateBundle(bundleId, partialBundle);
        await databasePlugin.commitBundle();
        return c.json({ success: true });
      } catch (error) {
        console.error("Error during bundle update:", error);
        if (error && typeof error === "object" && "message" in error) {
          return c.json({ error: error.message }, 500);
        }
        return c.json({ error: "Unknown error" }, 500);
      }
    },
  )
  .delete(
    "/bundles/:bundleId",
    typiaValidator("param", paramBundleIdSchema),
    async (c) => {
      try {
        const { bundleId } = c.req.valid("param");

        const { databasePlugin, storagePlugin } = await prepareConfig();
        // await databasePlugin.deleteBundle(bundleId);
        await databasePlugin.commitBundle();
        await storagePlugin.deleteBundle(bundleId);
        return c.json({ success: true });
      } catch (error) {
        console.error("Error during bundle deletion:", error);
        if (error && typeof error === "object" && "message" in error) {
          return c.json({ error: error.message }, 500);
        }
        return c.json({ error: "Unknown error" }, 500);
      }
    },
  );

export type RpcType = typeof rpc;
