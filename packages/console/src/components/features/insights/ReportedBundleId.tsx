import { ArtifactIdDisplay } from "@/components/ArtifactIdDisplay";
import { BuiltinBundleDisplay } from "@/components/BuiltinBundleDisplay";
import { ReleaseIdDisplay } from "@/components/ReleaseIdDisplay";

import { BuiltinBundleBadge, isBuiltinBundle } from "./BuiltinBundle";

/**
 * A bundle an installation reported: its release ID, the ID the app reports,
 * as its last 12 characters, marked when the release serves the built-in
 * bundle; a built-in bundle with no release by its name and the report's app
 * version; or any other bundle with no release by its artifact ID, which its
 * popover names as one.
 */
export function ReportedBundleId({
  releaseId,
  bundleId,
  minBundleId,
  appVersion,
  copyable = true,
}: {
  readonly releaseId: string | null | undefined;
  readonly bundleId: string;
  /** The report's built-in bundle ID, when the SDK reported it. */
  readonly minBundleId?: string;
  /** The app version of the report that names the bundle. */
  readonly appVersion?: string;
  /** Off inside a control that can't hold a button, such as a list's option. */
  readonly copyable?: boolean;
}) {
  const builtIn = isBuiltinBundle(bundleId, minBundleId);
  if (releaseId) {
    return (
      <>
        <ReleaseIdDisplay copyable={copyable} part="id" releaseId={releaseId} />
        {builtIn ? <BuiltinBundleBadge /> : null}
      </>
    );
  }
  return builtIn ? (
    <BuiltinBundleDisplay
      appVersion={appVersion}
      bundleId={bundleId}
      copyable={copyable}
    />
  ) : (
    <ArtifactIdDisplay artifactId={bundleId} copyable={copyable} />
  );
}
