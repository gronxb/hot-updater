import { p } from "@hot-updater/cli-tools";
import type { HotUpdaterCoreApi, ReleaseRow } from "@hot-updater/plugin-core";

/** Where a `v<N>` label names a bundle: its channel and platform. */
export interface LabelScopeOptions {
  readonly channel?: string;
  readonly platform?: "ios" | "android";
}

/** A release's label as people read it, `v12`, or empty without one. */
export const labelText = (release: Pick<ReleaseRow, "label">): string =>
  typeof release.label === "number" ? `v${release.label}` : "";

/**
 * The release ID `idOrLabel` names, which users call a bundle ID: itself,
 * or for `v<N>`, the release with that label in `-c`'s channel and `-p`'s
 * platform, one read. Exits with one
 * line when a flag is missing, no bundle has the label, or the server is
 * older than labels.
 */
export const resolveReleaseId = async (
  core: HotUpdaterCoreApi,
  idOrLabel: string,
  { channel, platform }: LabelScopeOptions,
): Promise<string> => {
  const match = /^v(\d+)$/iu.exec(idOrLabel.trim());
  if (match === null) return idOrLabel;
  if (!channel || !platform) {
    p.log.error(
      `A label needs its channel and platform: ${idOrLabel} -c <channel> -p <platform>.`,
    );
    process.exit(1);
  }
  const label = Number(match[1]);
  let release: ReleaseRow | null;
  try {
    release = await core.getReleaseByLabel({ channel, platform, label });
  } catch (error) {
    // A server of an earlier release has no label route.
    if ((error as { readonly status?: unknown } | null)?.status === 404) {
      p.log.error("This server can't look up labels: pass the bundle's ID.");
      process.exit(1);
    }
    throw error;
  }
  if (release === null) {
    p.log.error(`No bundle labeled v${label} on ${channel} ${platform}.`);
    process.exit(1);
  }
  return release.id;
};
