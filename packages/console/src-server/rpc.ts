import { typiaValidator } from "@hono/typia-validator";
import {
  type Bundle,
  type ConfigResponse,
  type DatabasePlugin,
  getCwd,
  loadConfig,
} from "@hot-updater/plugin-core";
import { Hono } from "hono";
import typia from "typia";

const bundlesValidator = typia.createValidate<{
  channel?: string;
  platform?: "ios" | "android";
  limit?: string;
  offset?: string;
}>();

const bundleIdValidator = typia.createValidate<{
  bundleId: string;
}>();

const updateBundleValidator = typia.createValidate<{
  targetBundleId: string;
  bundle: Partial<Bundle>;
}>();

let configPromise: Promise<{
  config: ConfigResponse;
  databasePlugin: DatabasePlugin;
}> | null = null;

const prepareConfig = async () => {
  if (!configPromise) {
    configPromise = (async () => {
      try {
        const config = await loadConfig(null);
        const databasePlugin =
          (await config?.database({ cwd: getCwd() })) ?? null;
        if (!databasePlugin) {
          throw new Error("Database plugin initialization failed");
        }
        return { config, databasePlugin };
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
  .get("/bundles", typiaValidator("query", bundlesValidator), async (c) => {
    try {
      const query = c.req.valid("query");
      const { databasePlugin } = await prepareConfig();
      const bundles = await databasePlugin.getBundles({
        where: {
          channel: query.channel ?? undefined,
          platform: query.platform ?? undefined,
        },
        limit: query.limit ? Number(query.limit) : undefined,
        offset: query.offset ? Number(query.offset) : undefined,
      });
      return c.json(bundles ?? []);
    } catch (error) {
      console.error("Error during bundle retrieval:", error);
      throw error;
    }
  })
  .get(
    "/bundles/:bundleId",
    typiaValidator("param", bundleIdValidator),
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
    typiaValidator("json", updateBundleValidator),
    async (c) => {
      try {
        const bundleId = c.req.param("bundleId");

        const { bundle } = c.req.valid("json");
        if (!bundleId) {
          return c.json({ error: "Target bundle ID is required" }, 400);
        }

        const { databasePlugin } = await prepareConfig();
        await databasePlugin.updateBundle(bundleId, bundle);
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
  );

export type RpcType = typeof rpc;
