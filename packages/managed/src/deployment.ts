import {
  prepareManagedBetterAuthDeployment,
  type ManagedBetterAuthDeploymentNotice,
} from "@hot-updater/better-auth/managed/provisioning";
import type { RuntimeHotUpdaterAPI } from "@hot-updater/server";
import type { HotUpdaterDBTarget } from "@hot-updater/server/db";

export type ManagedServerDeploymentNotice = ManagedBetterAuthDeploymentNotice;

export const prepareManagedServerDeployment = (options: {
  readonly envFilePath?: string;
  readonly target: HotUpdaterDBTarget;
}): Promise<readonly ManagedServerDeploymentNotice[]> =>
  prepareManagedBetterAuthDeployment({
    ...options,
    target: options.target as RuntimeHotUpdaterAPI,
  });
