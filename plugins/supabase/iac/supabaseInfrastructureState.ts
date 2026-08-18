import { LegacyInfrastructureError } from "@hot-updater/cli-tools";

import type { SupabaseApi } from "./supabaseApi";

export const assertSupabaseInfrastructureCanInitialize = async (
  api: SupabaseApi,
  projectId: string,
): Promise<void> => {
  if ((await api.getInfrastructureState()) === "v0") {
    throw new LegacyInfrastructureError("Supabase", `project ${projectId}`);
  }
};
