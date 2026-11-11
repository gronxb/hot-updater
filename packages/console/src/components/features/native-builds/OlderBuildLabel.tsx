import type { NativeBuildRow } from "@hot-updater/plugin-core";
import { History } from "lucide-react";

import { RowReason } from "@/components/RowReason";
import { nativeBuildArtifacts, nativeBuildLabel } from "@/lib/native-builds";

import { storeTrackLabels } from "./StoreSubmission";

/** How an `.ipa`'s export method names it, such as "ad hoc IPA". */
const EXPORT_METHOD_LABELS = {
  "app-store": "App Store",
  "ad-hoc": "ad hoc",
  development: "development",
  enterprise: "enterprise",
} as const;

/** What a path's builds are called, such as "TestFlight build" or "ad hoc IPA". */
const pathNoun = (build: NativeBuildRow) => {
  const artifact = nativeBuildArtifacts[build.artifact_kind].label;
  const noun =
    build.submitted_to !== null
      ? `${storeTrackLabels[build.submitted_to]} build`
      : build.artifact_kind === "ipa" && build.export_method !== null
        ? `${EXPORT_METHOD_LABELS[build.export_method]} ${artifact}`
        : artifact;
  return build.is_sandbox ? `sandbox ${noun}` : noun;
};

/** Why a build shows as older: the newer build on its path, when found. */
export const olderBuildReason = (newer: NativeBuildRow | undefined) => {
  if (newer === undefined) {
    return {
      sentence: "A newer build on its channel reaches people the same way.",
      label: "Older: a newer build on its channel reaches people the same way",
    };
  }
  const name = nativeBuildLabel(newer);
  return {
    sentence: `A newer ${pathNoun(newer)} exists${name === null ? "." : `: ${name}`}`,
    label: `Older: a newer ${pathNoun(newer)} exists${name === null ? "" : `, ${name}`}`,
  };
};

/**
 * "Older" on a build a newer one on its path passes over, quiet like the
 * Bundles list's "Unreachable", naming the newer build. The build may still
 * install, so it says no more.
 */
export function OlderBuildLabel({
  newer,
}: {
  /** The newer build on its path, when it was found. */
  readonly newer?: NativeBuildRow;
}) {
  const reason = olderBuildReason(newer);
  return (
    <RowReason icon={History} label={reason.label} reason={reason.sentence}>
      Older
    </RowReason>
  );
}
