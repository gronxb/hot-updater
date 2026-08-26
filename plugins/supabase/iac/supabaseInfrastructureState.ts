import {
  assertInfrastructureGenerationAtUrl,
  InitError,
} from "@hot-updater/cli-tools";

import type { SupabaseApi } from "./supabaseApi";

export const assertSupabaseInfrastructureCanInitialize = async (
  api: SupabaseApi,
  projectId: string,
): Promise<void> => {
  if ((await api.getInfrastructureState()) === "incompatible") {
    throw new InitError(
      `Supabase v1 infrastructure in project ${projectId} is incomplete or uses an unsupported database version.`,
    );
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
