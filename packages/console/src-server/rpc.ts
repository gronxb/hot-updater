import { vValidator } from "@hono/valibot-validator";
import {
  type Config,
  type UpdateSource,
  getCwd,
  loadConfig,
} from "@hot-updater/plugin-core";
import { Hono } from "hono";
import * as v from "valibot";

const updateSourceSchema = v.object({
  platform: v.union([v.literal("ios"), v.literal("android")]),
  targetVersion: v.string(),
  bundleTimestamp: v.number(),
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
  .get("/getUpdateSources", async (c) => {
    if (!config) {
      config = await loadConfig();
    }
    const deployPlugin = config?.deploy({
      cwd: getCwd(),
    });
    const updateSources = await deployPlugin?.getUpdateSources();
    return c.json((updateSources ?? []) satisfies UpdateSource[]);
  })
  .post(
    "/getUpdateSourceByBundleVersion",
    vValidator("json", v.object({ bundleTimestamp: v.number() })),
    async (c) => {
      const { bundleTimestamp } = c.req.valid("json");
      if (!config) {
        config = await loadConfig();
      }
      const deployPlugin = config?.deploy({
        cwd: getCwd(),
      });
      const updateSources = await deployPlugin?.getUpdateSources();
      const updateSource = updateSources?.find(
        (source) => source.bundleTimestamp === bundleTimestamp,
      );
      return c.json((updateSource ?? null) satisfies UpdateSource | null);
    },
  )
  .post(
    "/updateUpdateSource",
    vValidator(
      "json",
      v.object({
        targetBundleTimestamp: v.number(),
        updateSource: v.partial(updateSourceSchema),
      }),
    ),
    async (c) => {
      const { targetBundleTimestamp, updateSource } = c.req.valid("json");
      if (!config) {
        config = await loadConfig();
      }
      const deployPlugin = config?.deploy({
        cwd: getCwd(),
      });
      await deployPlugin?.updateUpdateSource(
        targetBundleTimestamp,
        updateSource,
      );
      await deployPlugin?.commitUpdateSource();
      return c.json(true);
    },
  );

export type RpcType = typeof rpc;
