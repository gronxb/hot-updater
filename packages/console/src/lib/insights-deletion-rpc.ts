import { createServerFn } from "@tanstack/react-start";

import { consoleAccess } from "./console-access";

/** Whose Insights data to delete: one installation's, or every installation of a user. */
export type InsightsDeletionTarget =
  | { readonly installId: string }
  | { readonly userId: string };

/** What one deletion call removed; `complete` is false while rows remain. */
export interface InsightsDeletionResult {
  readonly deleted: {
    readonly installations: number;
    readonly events: number;
  };
  readonly complete: boolean;
}

const MAX_ID_LENGTH = 255;

const readId = (value: unknown): string | undefined =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= MAX_ID_LENGTH
    ? value
    : undefined;

export const readDeletionTarget = (input: unknown): InsightsDeletionTarget => {
  const field = (name: string) =>
    typeof input === "object" && input !== null
      ? Reflect.get(input, name)
      : undefined;
  const installId = readId(field("installId"));
  const userId = readId(field("userId"));
  if ((installId === undefined) === (userId === undefined)) {
    throw new TypeError("Name one installation or one user to delete.");
  }
  return installId === undefined ? { userId: userId! } : { installId };
};

/**
 * Deletes one bounded batch of a target's Insights data: its events, then its
 * latest report. The caller repeats it until `complete`.
 */
export const deleteInsightsDataRpc = createServerFn({ method: "POST" })
  .middleware([consoleAccess])
  .validator(readDeletionTarget)
  .handler(async ({ data }): Promise<InsightsDeletionResult> => {
    const [{ prepareConfig }, { requireFeature }] = await Promise.all([
      import("./server/config.server"),
      import("./server/runtime.server"),
    ]);
    const { runtime } = await prepareConfig();
    const deletion = await requireFeature(runtime, "insightsDeletion");
    return "installId" in data
      ? deletion.deleteInstallation(data.installId)
      : deletion.deleteUser(data.userId);
  });
