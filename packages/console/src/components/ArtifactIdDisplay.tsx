import { cn } from "@/lib/utils";

import { CopyableIdTail, IdTailText } from "./IdTail";

interface ArtifactIdDisplayProps {
  /**
   * An artifact's ID: the bundles row that holds a deploy's manifest,
   * files, and patches, or a native build's built-in bundle. Never a
   * release's ID, which `ReleaseIdDisplay` shows.
   */
  artifactId: string;
  /**
   * Whether the tail is a copy button, as a release's is. Turn it off where
   * the display sits inside another control that can't hold a button, such
   * as a link: the full ID then shows on hover from `title`.
   */
  copyable?: boolean;
  className?: string;
}

/**
 * An artifact's ID as its last 12 characters, the way the Console shows
 * every ID: the whole ID stays in the text, hovering or focusing it shows
 * it in a popover that says it's an artifact's, and a click copies it. It
 * takes no label: a label names a release, and its tail is that release's
 * ID.
 */
export function ArtifactIdDisplay({
  artifactId,
  copyable = true,
  className,
}: ArtifactIdDisplayProps) {
  // A value among values: their size and color, not a label's muted tail.
  const valueClass = cn("text-xs text-foreground", className);
  return copyable ? (
    <span className="inline-flex whitespace-nowrap">
      <CopyableIdTail
        id={artifactId}
        kind="artifact"
        // Its 16 px line reaches 44 px tall on a phone.
        className={cn(valueClass, "after:-inset-y-3.5")}
      />
    </span>
  ) : (
    <IdTailText id={artifactId} className={valueClass} />
  );
}
