import type { ReleaseModel, ReleaseRow } from "@hot-updater/plugin-core";

export interface ReleaseListInput {
  afterReleaseId?: string;
  beforeReleaseId?: string;
  bundleId?: string;
  channelId?: string;
  enabled?: boolean;
  limit: number;
  page?: number;
  platform?: "ios" | "android";
  targetAppVersion?: string;
}

export interface ReleaseListResult {
  data: readonly ReleaseRow[];
  pagination: {
    currentPage: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
}

export async function listReleases(
  releases: ReleaseModel,
  input: ReleaseListInput,
): Promise<ReleaseListResult> {
  const page = input.page ?? 1;
  const rows = await releases.findMany({
    ...(input.afterReleaseId === undefined
      ? {}
      : { afterReleaseId: input.afterReleaseId }),
    ...(input.beforeReleaseId === undefined
      ? {}
      : { beforeReleaseId: input.beforeReleaseId }),
    ...(input.bundleId === undefined ? {} : { bundleId: input.bundleId }),
    ...(input.channelId === undefined ? {} : { channelId: input.channelId }),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    ...(input.platform === undefined ? {} : { platform: input.platform }),
    ...(input.targetAppVersion === undefined
      ? {}
      : { targetAppVersion: input.targetAppVersion }),
    limit: input.limit + 1,
  });
  const isPreviousRequest = input.afterReleaseId !== undefined;
  const hasExtraRow = rows.length > input.limit;
  const data = isPreviousRequest
    ? hasExtraRow
      ? rows.slice(1)
      : rows
    : rows.slice(0, input.limit);

  return {
    data,
    pagination: {
      currentPage: page,
      hasNextPage: isPreviousRequest || hasExtraRow,
      hasPreviousPage: page > 1,
    },
  };
}
