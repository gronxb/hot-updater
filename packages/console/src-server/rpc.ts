import { vValidator } from "@hono/valibot-validator";
import {
  type Bundle,
  type Config,
  getCwd,
  loadConfig,
} from "@hot-updater/plugin-core";
import { Hono } from "hono";
import * as v from "valibot";

const bundleSchema = v.object({
  platform: v.union([v.literal("ios"), v.literal("android")]),
  targetVersion: v.string(),
  id: v.string(),
  forceUpdate: v.boolean(),
  enabled: v.boolean(),
  file: v.string(),
  hash: v.string(),
  description: v.optional(v.string(), ""),
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
    const deployPlugin = config?.deploy({
      cwd: getCwd(),
    });
    const bundles = await deployPlugin?.getBundles();
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
      const deployPlugin = config?.deploy({
        cwd: getCwd(),
      });
      const bundles = await deployPlugin?.getBundles();
      const bundle = bundles?.find((bundle) => bundle.id === bundleId);
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
      const deployPlugin = config?.deploy({
        cwd: getCwd(),
      });
      await deployPlugin?.updateBundle(targetBundleId, bundle);
      await deployPlugin?.commitBundle();
      return c.json(true);
    },
  );

export type RpcType = typeof rpc;
