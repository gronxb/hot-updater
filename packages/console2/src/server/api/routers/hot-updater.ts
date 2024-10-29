import type { UpdateSource } from "@hot-updater/utils";
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

export const hotUpdaterRouter = createTRPCRouter({
  hello: publicProcedure.input(wrap(string())).query(({ input }) => {
    return `Hello ${input}!`;
  }),
  getUpdateSources: publicProcedure.query(async ({ ctx }) => {
    return [
      {
        platform: "ios",
        targetVersion: "1.0",
        file: "http://example.com/bundle.zip",
        hash: "hash",
        forceUpdate: true,
        enabled: false, // Disabled
        bundleVersion: 2,
      },
    ] as UpdateSource[];
  }),
  getUpdateSourceByBundleVersion: publicProcedure
    .input(wrap(number()))
    .query(async ({ ctx, input }) => {
      return null as UpdateSource | null;
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
      return null as UpdateSource | null;
    }),
});
