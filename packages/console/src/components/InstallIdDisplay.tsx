import { cn } from "@/lib/utils";

import { CopyableIdTail, IdTailText } from "./IdTail";

interface InstallIdDisplayProps {
  /**
   * An installation's ID: the one the app creates on its first launch and
   * reports with every Insights event. Not a release's or an artifact's.
   */
  installId: string;
  /**
   * Whether the tail is a copy button. Turn it off where the display sits
   * inside another control that can't hold a button, such as a list's
   * option: the full ID then shows on hover from `title`.
   */
  copyable?: boolean;
  className?: string;
}

/**
 * An installation's ID as its last 12 characters, the way the Console shows
 * every ID: the whole ID stays in the text, hovering or focusing it shows
 * it in a popover that says it's an install ID, and a click copies it.
 */
export function InstallIdDisplay({
  installId,
  copyable = true,
  className,
}: InstallIdDisplayProps) {
  // A value among values: their size and color, not a label's muted tail.
  const valueClass = cn("text-xs text-foreground", className);
  return copyable ? (
    <span className="inline-flex whitespace-nowrap">
      <CopyableIdTail
        id={installId}
        kind="install"
        // Its 16 px line reaches 44 px tall on a phone.
        className={cn(valueClass, "after:-inset-y-3.5")}
      />
    </span>
  ) : (
    <IdTailText id={installId} className={valueClass} />
  );
}
