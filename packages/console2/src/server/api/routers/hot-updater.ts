import { type Config, getCwd, loadConfig } from "@hot-updater/plugin-core";
import { wrap } from "@typeschema/valibot";
import {
  boolean,
  literal,
  number,
  object,
  optional,
  partial,
  string,
  union,
} from "valibot";
import { createTRPCRouter, publicProcedure } from "../utils";

const updateSourceSchema = object({
  platform: union([literal("ios"), literal("android")]),
  targetVersion: string(),
  bundleVersion: number(),
  forceUpdate: boolean(),
  enabled: boolean(),
  file: string(),
  hash: string(),
  description: optional(string(), ""),
});

let config: Config | null = null;

export const hotUpdaterRouter = createTRPCRouter({
  hello: publicProcedure.query(async () => "hello"),
  loadConfig: publicProcedure.query(async ({ ctx }) => {
    config = await loadConfig();
    return true;
  }),
  isConfigLoaded: publicProcedure.query(async ({ ctx }) => {
    return config !== null;
  }),
  getUpdateSources: publicProcedure.query(async ({ ctx }) => {
    if (!config) {
      config = await loadConfig();
    }
    const deployPlugin = config?.deploy({
      cwd: getCwd(),
    });
    return deployPlugin?.getUpdateSources();
  }),
  getUpdateSourceByBundleVersion: publicProcedure
    .input(wrap(number()))
    .query(async ({ ctx, input }) => {
      if (!config) {
        config = await loadConfig();
      }
      const deployPlugin = config?.deploy({
        cwd: getCwd(),
      });
      const updateSources = await deployPlugin?.getUpdateSources();
      return (
        updateSources?.find((source) => source.bundleVersion === input) ?? null
      );
    }),
  updateUpdateSource: publicProcedure
    .input(
      wrap(
        object({
          targetBundleVersion: number(),
          updateSource: partial(updateSourceSchema),
        }),
      ),
    )
    .mutation(async ({ ctx, input }) => {
      if (!config) {
        config = await loadConfig();
      }

      const deployPlugin = config?.deploy({
        cwd: getCwd(),
      });
      await deployPlugin?.updateUpdateSource(
        input.targetBundleVersion,
        input.updateSource,
      );
      await deployPlugin?.commitUpdateSource();
      return true;
    }),
});
