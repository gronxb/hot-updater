import { vValidator } from "@hono/valibot-validator";
import {
  type Bundle,
  type Config,
  getCwd,
  loadConfig,
} from "@hot-updater/plugin-core";
import { Hono } from "hono";
import * as v from "valibot";

export const bundleSchema = v.object({
  platform: v.union([v.literal("ios"), v.literal("android")]),
  targetAppVersion: v.string(),
  id: v.string(),
  forceUpdate: v.boolean(),
  enabled: v.boolean(),
  fileUrl: v.string(),
  fileHash: v.string(),
  gitCommitHash: v.nullable(v.string()),
  message: v.nullable(v.string()),
});

let config: Config | null = null;

export const rpc = new Hono()
  .get("/loadConfig", async (c) => {
    config = await loadConfig();
    return c.json(true);
  })
  .get("/isConfigLoaded", (c) => {
    return c.json(config !== null);
  })
  .get("/getBundles", async (c) => {
    if (!config) {
      config = await loadConfig();
    }
    const databasePlugin = config?.database({
      cwd: getCwd(),
    });
    const bundles = await databasePlugin?.getBundles();
    return c.json((bundles ?? []) satisfies Bundle[]);
  })
  .post(
    "/getBundleById",
    vValidator("json", v.object({ bundleId: v.string() })),
    async (c) => {
      const { bundleId } = c.req.valid("json");
      if (!config) {
        config = await loadConfig();
      }
      const databasePlugin = config?.database({
        cwd: getCwd(),
      });
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
      if (!config) {
        config = await loadConfig();
      }
      const databasePlugin = config?.database({
        cwd: getCwd(),
      });
      await databasePlugin?.updateBundle(targetBundleId, bundle);
      await databasePlugin?.commitBundle();
      return c.json(true);
    },
  );

export type RpcType = typeof rpc;
