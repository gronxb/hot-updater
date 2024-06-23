import type { HotUpdaterReadStrategy, UpdateSource } from "./types";

export interface NextUpdateOptions {
  platform: "ios" | "android";
  targetVersion: string;
  forceUpdate?: boolean;
}

export const getNextUpdate = async (
  readStrategy: HotUpdaterReadStrategy,
  options: NextUpdateOptions,
) => {
  const bundleVersion = Date.now();
  const files = await readStrategy.getListObjects();
  return {
    ...options,
    files,
    bundleVersion,
    enabled: true,
  } as UpdateSource;
};
