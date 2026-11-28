import { cloneElement, type ReactElement, type ReactNode } from "react";

import { cn } from "@/lib/utils";

import { CopyableIdTail, IdTailText } from "./IdTail";
import { PlatformIcon } from "./PlatformIcon";

const LABEL_CLASS = "shrink-0 font-medium text-sm text-foreground tabular-nums";

/**
 * A label or a tail shown alone sits among a table's or a sheet's other
 * values, which are `text-xs`, so it takes their size rather than the
 * composite's `text-sm`.
 */
const PART_SIZE = "text-xs";

/**
 * An ID shown alone is a value like the ones beside it, so it takes their
 * color too, rather than the muted color that sets a tail apart from its
 * label.
 */
const ALONE_ID_CLASS = cn(PART_SIZE, "text-foreground");

/** A release without a label yet, where its label would show: `db migrate` labels it. */
const NoLabel = ({ name }: { readonly name: string }) => (
  <>
    <span aria-hidden="true">—</span>
    <span className="sr-only" translate="no">
      {name}
    </span>
  </>
);

interface ReleaseIdDisplayProps {
  /**
   * The release's ID: what users call its bundle ID, and what the app's
   * `getBundleId()` returns. Never an artifact's ID, which
   * `ArtifactIdDisplay` shows: a label's tail is always its release ID.
   */
  releaseId: string;
  /**
   * The release's label, shown `v12 <ID tail>`: the name people use for it,
   * then the last 12 characters of its ID. The whole ID stays in the text,
   * so screen readers read it, and hovering, focusing, or tapping the tail
   * shows it in a popover; a click or Enter copies it. Left out, or null
   * for a release without one, shows the tail alone, after a muted dash in
   * `labelAs` when given.
   */
  label?: number | null;
  /**
   * Whether the tail is that copy button. Turn it off where the display sits
   * inside another control that can't hold a button, such as a combobox
   * option, a link, or a chart tooltip: the full ID then shows on hover from
   * `title`, and the control keeps every click.
   */
  copyable?: boolean;
  /**
   * The element the label renders as, such as the button or link that opens
   * the release, so the tail stays its own copy button beside it rather than
   * inside the caller's control. A release without a label renders a muted
   * dash in it, read as its whole ID unless the control has its own name.
   */
  labelAs?: ReactElement<{ className?: string; children?: ReactNode }>;
  /**
   * The release's platform, shown as its icon before the label. A label is
   * unique only within a channel and platform, so pass it where one surface
   * lists both platforms' releases, and leave it out where the screen
   * already fixes the platform or shows it beside the release.
   */
  platform?: "ios" | "android";
  /**
   * One half of the display, for a surface that heads the label and the ID
   * separately, such as the Bundles table's Label and ID columns and the
   * release sheet's Label and ID rows. `label` renders `v12` alone (in
   * `labelAs` when given), or a muted dash for a release without one.
   * `id` renders the ID's tail alone, the same copy button, whether or not
   * the release has a label, in the size and color of the values beside it.
   * Left out, the display shows both.
   */
  part?: "label" | "id";
  className?: string;
}

/**
 * A release, named the way people read it: `v12 <ID tail>`, or its ID tail
 * without a label; or, with `part`, its label or its ID tail alone. The only
 * display that takes a label.
 */
export function ReleaseIdDisplay({
  releaseId,
  label,
  copyable = true,
  labelAs,
  platform,
  part,
  className,
}: ReleaseIdDisplayProps) {
  const prefix = platform ? <PlatformPrefix platform={platform} /> : null;
  const labeled = typeof label === "number";
  if (part === "id") {
    return copyable ? (
      <span className={cn("inline-flex whitespace-nowrap", className)}>
        <CopyableIdTail
          id={releaseId}
          kind="release"
          // Its 16 px line reaches 44 px tall on a phone, as the composite's
          // 20 px line does with 12 px above and below.
          className={cn(ALONE_ID_CLASS, "after:-inset-y-3.5")}
        />
      </span>
    ) : (
      <IdTailText id={releaseId} className={cn(ALONE_ID_CLASS, className)} />
    );
  }
  if (part === "label") {
    const text = labeled ? `v${label}` : <NoLabel name="No label" />;
    const textClass = labeled
      ? cn(LABEL_CLASS, PART_SIZE)
      : cn(PART_SIZE, "text-muted-foreground");
    const named = labelAs ? (
      cloneElement(labelAs, {
        // The display's color wins over the caller's, so a dash stays muted.
        className: cn(labelAs.props.className, textClass),
        children: text,
      })
    ) : (
      <span translate="no" className={textClass}>
        {text}
      </span>
    );
    return (
      <span
        className={cn("inline-flex min-w-0 items-baseline gap-1.5", className)}
      >
        {prefix}
        {named}
      </span>
    );
  }
  // A release without a label opens from a muted dash where `labelAs` is
  // given, and shows its tail alone otherwise: never its full ID.
  const name = labeled ? (
    labelAs ? (
      cloneElement(labelAs, {
        className: cn(LABEL_CLASS, labelAs.props.className),
        children: `v${label}`,
      })
    ) : (
      <span translate="no" className={LABEL_CLASS}>
        v{label}
      </span>
    )
  ) : labelAs ? (
    cloneElement(labelAs, {
      className: cn(
        labelAs.props.className,
        "shrink-0 text-sm text-muted-foreground",
      ),
      // Read as its whole ID, so a list of links keeps one name per
      // release, unless the control names itself.
      children: (
        <NoLabel
          name={
            (labelAs.props as { "aria-label"?: string })["aria-label"]
              ? "No label"
              : releaseId
          }
        />
      ),
    })
  ) : null;
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-baseline gap-1.5 whitespace-nowrap",
        className,
      )}
      title={copyable ? undefined : releaseId}
    >
      {prefix}
      {name}
      {/* Read as "v12 <id>"; the flex gap draws the space. */}
      {name ? " " : null}
      {copyable ? (
        <CopyableIdTail id={releaseId} kind="release" />
      ) : (
        <IdTailText id={releaseId} />
      )}
    </span>
  );
}

/** A platform's icon, read as its name: the context a label needs on a mixed list. */
function PlatformPrefix({
  platform,
}: {
  readonly platform: "ios" | "android";
}) {
  return (
    <span className="inline-flex shrink-0 self-center text-muted-foreground">
      <PlatformIcon platform={platform} className="size-3.5" />
      <span className="sr-only">{platform === "ios" ? "iOS" : "Android"} </span>
    </span>
  );
}
