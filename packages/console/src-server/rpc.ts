import { typiaValidator } from "@hono/typia-validator";
import {
  type Bundle,
  type Config,
  type DatabasePlugin,
  getCwd,
  loadConfig,
} from "@hot-updater/plugin-core";
import { Hono } from "hono";
import typia from "typia";

const bundleIdValidator = typia.createValidate<{
  bundleId: string;
}>();

const updateBundleValidator = typia.createValidate<{
  targetBundleId: string;
  bundle: Partial<Bundle>;
}>();

let config: Config | null = null;
let databasePlugin: DatabasePlugin | null = null;

const prepareConfig = async () => {
  if (!config) {
    config = await loadConfig({
      platform: "console",
    });
    databasePlugin =
      (await config?.database({
        cwd: getCwd(),
      })) ?? null;
  }
  return { config, databasePlugin };
};

export const rpc = new Hono()
  .get("/getConfig", async (c) => {
    const { config } = await prepareConfig();

    return c.json({
      console: config?.console,
    });
  })
  .get("/isConfigLoaded", (c) => {
    return c.json(config !== null);
  })
  .get("/getBundles", async (c) => {
    const { databasePlugin } = await prepareConfig();

    const bundles = await databasePlugin?.getBundles(true);
    return c.json((bundles ?? []) satisfies Bundle[]);
  })
  .get(
    "/getBundleById",
    typiaValidator("query", bundleIdValidator),
    async (c) => {
      const { bundleId } = c.req.valid("query");
      const { databasePlugin } = await prepareConfig();

      const bundle = await databasePlugin?.getBundleById(bundleId);
      return c.json((bundle ?? null) satisfies Bundle | null);
    },
  )
  .post(
    "/updateBundle",
    typiaValidator("json", updateBundleValidator),
    async (c) => {
      const { targetBundleId, bundle } = c.req.valid("json");
      const { databasePlugin } = await prepareConfig();

      await databasePlugin?.updateBundle(targetBundleId, bundle);
      await databasePlugin?.commitBundle();
      return c.json(true);
    },
  );

export type RpcType = typeof rpc;
