import {
  cloneElement,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

import { PlatformIcon } from "./PlatformIcon";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/**
 * How much of a labeled release's ID shows after its label: its last 6
 * characters, like a git short hash. A UUIDv7's head is a timestamp that
 * neighbouring releases share; the tail tells them apart.
 */
const LABELED_ID_TAIL = 6;

/** How long "Copied" shows before the popover reads "Click to copy" again. */
const COPIED_MS = 1_500;

const LABEL_CLASS = "shrink-0 font-medium text-sm text-foreground tabular-nums";

interface BundleIdDisplayProps {
  bundleId: string;
  /**
   * The release's label, shown `v12 <ID tail>`: the name people use for it,
   * then the end of its ID. The whole ID stays in the text, so screen readers
   * read it, and hovering, focusing, or tapping the tail shows it in a
   * popover; a click or Enter copies it. Left out, or null for a release
   * without one, shows the full ID alone.
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
   * inside the caller's control. A release without a label renders its full
   * ID in it.
   */
  labelAs?: ReactElement<{ className?: string; children?: ReactNode }>;
  /**
   * The release's platform, shown as its icon before the label. A label is
   * unique only within a channel and platform, so pass it where one surface
   * lists both platforms' releases, and leave it out where the screen
   * already fixes the platform or shows it beside the release.
   */
  platform?: "ios" | "android";
  maxLength?: number;
  className?: string;
  fullOnMobile?: boolean;
}

export function BundleIdDisplay({
  bundleId,
  label,
  copyable = true,
  labelAs,
  platform,
  className,
}: BundleIdDisplayProps) {
  const prefix = platform ? <PlatformPrefix platform={platform} /> : null;
  if (typeof label !== "number") {
    const id = (
      <span
        translate="no"
        className={cn(
          "break-all font-mono text-xs tabular-nums",
          !prefix && className,
        )}
      >
        {bundleId}
      </span>
    );
    const named = labelAs ? cloneElement(labelAs, { children: id }) : id;
    return prefix ? (
      <span
        className={cn("inline-flex min-w-0 items-baseline gap-1.5", className)}
      >
        {prefix}
        {named}
      </span>
    ) : (
      named
    );
  }
  const clipped = bundleId.length > LABELED_ID_TAIL;
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-baseline gap-1.5 whitespace-nowrap",
        className,
      )}
      title={copyable ? undefined : bundleId}
    >
      {prefix}
      {labelAs ? (
        cloneElement(labelAs, {
          className: cn(LABEL_CLASS, labelAs.props.className),
          children: `v${label}`,
        })
      ) : (
        <span translate="no" className={LABEL_CLASS}>
          v{label}
        </span>
      )}
      {/* Read as "v12 <id>"; the flex gap draws the space. */}{" "}
      {copyable ? (
        <CopyableTail bundleId={bundleId} clipped={clipped} />
      ) : (
        <span translate="no" className={tailClass(clipped)}>
          {bundleId}
        </span>
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

/**
 * The tail: the whole ID stays in the text, clipped to its last characters
 * from the left (one `ch` per monospace character), in the label's size.
 */
const TAIL_CLASS = "font-mono text-sm text-muted-foreground tabular-nums";
const CLIP_CLASS = "inline-flex w-[6ch] shrink-0 justify-end overflow-hidden";
const tailClass = (clipped: boolean) => cn(TAIL_CLASS, clipped && CLIP_CLASS);

/** The tail as a button: the full ID in a popover, and a click copies it. */
function CopyableTail({
  bundleId,
  clipped,
}: {
  readonly bundleId: string;
  readonly clipped: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async (touch: boolean) => {
    clearTimeout(timer.current);
    setOpen(true);
    try {
      await navigator.clipboard.writeText(bundleId);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
    timer.current = setTimeout(() => {
      setCopied(null);
      // A tap opened it, and no pointer leaves to close it.
      if (touch) setOpen(false);
    }, COPIED_MS);
  };

  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    // The row, card, or highlight the display sits in keeps its own clicks.
    event.preventDefault();
    event.stopPropagation();
    const { pointerType } = event.nativeEvent as PointerEvent;
    void copy(pointerType === "touch" || pointerType === "pen");
  };

  return (
    <>
      <Tooltip open={open} onOpenChange={setOpen} triggerId={id}>
        <TooltipTrigger
          closeOnClick={false}
          id={id}
          render={
            <button
              type="button"
              aria-describedby={open ? `${id}-full` : undefined}
              aria-label={`Copy ID ${bundleId}`}
              translate="no"
              className={cn(
                TAIL_CLASS,
                // A 44 px tall touch target on a phone, as an ID copy is: the
                // button stays unclipped so its touch area reaches past it.
                "relative inline-flex shrink-0 cursor-copy touch-manipulation rounded-sm outline-none transition-colors after:absolute after:inset-x-0 after:-inset-y-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:after:hidden motion-reduce:transition-none",
              )}
              onClick={onClick}
            />
          }
        >
          <span className={clipped ? CLIP_CLASS : undefined}>{bundleId}</span>
        </TooltipTrigger>
        <TooltipContent
          className="max-w-80 flex-col items-start gap-0.5"
          id={`${id}-full`}
          role="tooltip"
        >
          <p
            translate="no"
            className="break-all font-mono text-xs tabular-nums"
          >
            {bundleId}
          </p>
          <p className="text-background/70">
            {copied === "copied"
              ? "Copied"
              : copied === "failed"
                ? "Couldn't copy"
                : "Click to copy"}
          </p>
        </TooltipContent>
      </Tooltip>
      <span role="status" className="sr-only">
        {copied === "copied"
          ? "ID copied"
          : copied === "failed"
            ? "Couldn't copy the ID"
            : ""}
      </span>
    </>
  );
}
