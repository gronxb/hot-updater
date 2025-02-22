import { vValidator } from "@hono/valibot-validator";
import {
  type Bundle,
  type Config,
  type DatabasePlugin,
  getCwd,
  loadConfig,
} from "@hot-updater/plugin-core";
import { Hono } from "hono";
import * as v from "valibot";

export const bundleSchema = v.object({
  platform: v.union([v.literal("ios"), v.literal("android")]),
  targetAppVersion: v.string(),
  id: v.string(),
  shouldForceUpdate: v.boolean(),
  enabled: v.boolean(),
  fileUrl: v.string(),
  fileHash: v.string(),
  gitCommitHash: v.nullable(v.string()),
  message: v.nullable(v.string()),
});

let config: Config | null = null;
let databasePlugin: DatabasePlugin | null = null;

const prepareConfig = async () => {
  if (!config) {
    config = await loadConfig();
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
    vValidator("query", v.object({ bundleId: v.string() })),
    async (c) => {
      const { bundleId } = c.req.valid("query");
      const { databasePlugin } = await prepareConfig();

      const bundle = await databasePlugin?.getBundleById(bundleId);
      return c.json((bundle ?? null) satisfies Bundle | null);
    },
  )
  .post(
    "/updateBundle",
    vValidator(
      "json",
      v.object({
        targetBundleId: v.string(),
        bundle: v.partial(v.omit(bundleSchema, ["id"])),
      }),
    ),
    async (c) => {
      const { targetBundleId, bundle } = c.req.valid("json");
      const { databasePlugin } = await prepareConfig();

      await databasePlugin?.updateBundle(targetBundleId, bundle);
      await databasePlugin?.commitBundle();
      return c.json(true);
    },
  );

export type RpcType = typeof rpc;
