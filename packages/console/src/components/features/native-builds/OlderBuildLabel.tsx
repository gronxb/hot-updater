import type { NativeBuildRow } from "@hot-updater/plugin-core";
import { History } from "lucide-react";

import { RowReason } from "@/components/RowReason";
import { nativeBuildArtifacts, nativeBuildLabel } from "@/lib/native-builds";

import { storeTrackLabels } from "./StoreSubmission";

/** What a path's builds are called, such as "TestFlight build" or "APK". */
const pathNoun = (build: NativeBuildRow) => {
  const noun =
    build.submitted_to === null
      ? nativeBuildArtifacts[build.artifact_kind].label
      : `${storeTrackLabels[build.submitted_to]} build`;
  return build.is_sandbox ? `sandbox ${noun}` : noun;
};

/** Why a build shows as older: the newer build on its path. */
export const olderBuildReason = (newer: NativeBuildRow) => {
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
export function OlderBuildLabel({ newer }: { readonly newer: NativeBuildRow }) {
  const reason = olderBuildReason(newer);
  return (
    <RowReason icon={History} label={reason.label} reason={reason.sentence}>
      Older
    </RowReason>
  );
}
