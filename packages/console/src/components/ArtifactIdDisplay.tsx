import { cn } from "@/lib/utils";

interface ArtifactIdDisplayProps {
  /**
   * An artifact's ID: the bundles row that holds a deploy's manifest,
   * files, and patches, or a native build's built-in bundle. Never a
   * release's ID, which `ReleaseIdDisplay` shows.
   */
  artifactId: string;
  className?: string;
}

/**
 * An artifact's full ID, as plain text. It takes no label: a label names a
 * release, and its tail is that release's ID. A click selects the whole ID,
 * so a copy takes all of it, and the display holds no button, so it sits
 * inside a link or a control.
 */
export function ArtifactIdDisplay({
  artifactId,
  className,
}: ArtifactIdDisplayProps) {
  return (
    <span
      translate="no"
      className={cn(
        "break-all font-mono text-xs tabular-nums select-all",
        className,
      )}
    >
      {artifactId}
    </span>
  );
}
