import { ArtifactIdDisplay } from "@/components/ArtifactIdDisplay";
import { ReleaseIdDisplay } from "@/components/ReleaseIdDisplay";

/**
 * A bundle an installation reported, as its ID's last 12 characters: its
 * release ID, the ID the app reports, or for a bundle with no release, such
 * as the built-in bundle, its artifact ID, which its popover names as one.
 */
export function ReportedBundleId({
  releaseId,
  bundleId,
  copyable = true,
}: {
  readonly releaseId: string | null | undefined;
  readonly bundleId: string;
  /** Off inside a control that can't hold a button, such as a list's option. */
  readonly copyable?: boolean;
}) {
  return releaseId ? (
    <ReleaseIdDisplay copyable={copyable} part="id" releaseId={releaseId} />
  ) : (
    <ArtifactIdDisplay artifactId={bundleId} copyable={copyable} />
  );
}
