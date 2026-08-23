import {
  assertInfrastructureGenerationAtUrl,
  LegacyInfrastructureError,
} from "@hot-updater/cli-tools";

import type { SupabaseApi } from "./supabaseApi";

export const assertSupabaseInfrastructureCanInitialize = async (
  api: SupabaseApi,
  projectId: string,
): Promise<void> => {
  if ((await api.getInfrastructureState()) === "v0") {
    throw new LegacyInfrastructureError("Supabase", `project ${projectId}`);
  }
};

export const assertSupabaseFunctionCanInitialize = async ({
  fetchImpl,
  functionName,
  functionSlugs,
  projectId,
}: {
  readonly fetchImpl?: typeof fetch;
  readonly functionName: string;
  readonly functionSlugs: readonly string[];
  readonly projectId: string;
}): Promise<void> => {
  if (!functionSlugs.includes(functionName)) return;

  await assertInfrastructureGenerationAtUrl({
    fetchImpl,
    provider: "Supabase",
    resource: `Edge Function ${functionName}`,
    versionUrl: `https://${projectId}.supabase.co/functions/v1/${encodeURIComponent(functionName)}/version`,
  });
};
