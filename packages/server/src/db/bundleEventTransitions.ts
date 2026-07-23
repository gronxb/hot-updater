import type { BundleEventRow } from "@hot-updater/plugin-core";

export type TransitionBundleEventRow = Exclude<
  BundleEventRow,
  { readonly type: "UNCHANGED" }
>;

export const isTransitionBundleEventRow = (
  row: BundleEventRow,
): row is TransitionBundleEventRow =>
  row.type === "UPDATE_APPLIED" || row.type === "RECOVERED";
