import type { NativeBuildRow } from "@hot-updater/plugin-core";

/**
 * The way a build reaches people, from its row alone: the store track it was
 * submitted to, or else its artifact. An unsubmitted IPA is one path whether
 * it was exported ad hoc or for the App Store, as no column tells them apart.
 */
export type NativeBuildPath =
  | NonNullable<NativeBuildRow["submitted_to"]>
  | NativeBuildRow["artifact_kind"];

type PathColumns = Pick<
  NativeBuildRow,
  "platform" | "channel_id" | "is_sandbox" | "submitted_to" | "artifact_kind"
>;

export const nativeBuildPathOf = (build: PathColumns): NativeBuildPath =>
  build.submitted_to ?? build.artifact_kind;

/**
 * The distribution path a build is one of: its platform, the channel it
 * embeds, whether it is a sandbox build, and its path. A newer build on the
 * same path is the one people get there.
 */
export const nativeBuildPathKey = (build: PathColumns): string =>
  JSON.stringify([
    build.platform,
    build.channel_id,
    build.is_sandbox,
    nativeBuildPathOf(build),
  ]);

/** Whether the registry recorded `a` after `b`: server time, then the ID. */
const isNewer = (a: NativeBuildRow, b: NativeBuildRow) =>
  a.created_at_ms === b.created_at_ms
    ? a.id > b.id
    : a.created_at_ms > b.created_at_ms;

/**
 * Each build of `rows` that a newer build on its path passes over, with that
 * newest build. Newer is the registry's own order, its server time, then its
 * ID. The marked store build is never passed over. A pure function of the
 * rows: a build whose newer sibling is on another page is not in it.
 */
export function newerBuildsOnPath(
  rows: readonly NativeBuildRow[],
): ReadonlyMap<string, NativeBuildRow> {
  const newest = new Map<string, NativeBuildRow>();
  for (const row of rows) {
    const key = nativeBuildPathKey(row);
    const current = newest.get(key);
    if (current === undefined || isNewer(row, current)) newest.set(key, row);
  }
  const passedOver = new Map<string, NativeBuildRow>();
  for (const row of rows) {
    const top = newest.get(nativeBuildPathKey(row));
    if (top !== undefined && top.id !== row.id && !row.is_store_build) {
      passedOver.set(row.id, top);
    }
  }
  return passedOver;
}
