import {
  StoragePluginError,
  type StorageOperationContext,
} from "@hot-updater/plugin-core/storage";

import type { createS3ClientOwner } from "./client";

export type S3OperationEnvironment = Readonly<{
  owner: ReturnType<typeof createS3ClientOwner>;
  target: "node" | "functions";
}>;

export const assertS3Target = (
  context: StorageOperationContext,
  target: S3OperationEnvironment["target"],
): void => {
  if (context.target !== target) {
    throw new StoragePluginError(
      "invalid-input",
      `AWS S3 storage requires a ${target} context.`,
    );
  }
};
