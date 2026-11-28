import { useEffect, useId, useRef, useState, type MouseEvent } from "react";

import { ID_TAIL } from "@/lib/id-tail";
import { cn } from "@/lib/utils";

import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/** How long "Copied" shows before the popover reads "Click to copy" again. */
const COPIED_MS = 1_500;

/**
 * The tail's text: the whole ID stays in it, so screen readers read all of
 * it, clipped from the left to its last 12 characters (one `ch` per
 * monospace character).
 */
const TAIL_CLASS = "font-mono text-sm text-muted-foreground tabular-nums";
// `ID_TAIL` characters wide: Tailwind needs the class spelled out.
const CLIP_CLASS = "inline-flex w-[12ch] shrink-0 justify-end overflow-hidden";

/** The class that clips `id` to its tail; none for an ID that short. */
const clipOf = (id: string) => (id.length > ID_TAIL ? CLIP_CLASS : undefined);

/** What an ID is, in a copy button's name and its popover. */
export type IdKind = "release" | "artifact" | "install";

/**
 * How a copy button and its popover name each kind. A release's ID is just
 * "ID", what users call a bundle ID; the others say what they are, since
 * they are different IDs.
 */
const NAMES = {
  release: { noun: "ID", title: null },
  artifact: { noun: "artifact ID", title: "Artifact ID" },
  install: { noun: "install ID", title: "Install ID" },
} as const satisfies Record<IdKind, { noun: string; title: string | null }>;

/**
 * The tail as text, for a display inside another control that can't hold a
 * button (a link, a combobox option, a chart tooltip): the full ID shows on
 * hover from `title`, and the control keeps every click.
 */
export function IdTailText({
  id,
  className,
}: {
  readonly id: string;
  /** Overrides the tail's size and color. */
  readonly className?: string;
}) {
  return (
    <span
      translate="no"
      className={cn(TAIL_CLASS, clipOf(id), "whitespace-nowrap", className)}
      title={id}
    >
      {id}
    </span>
  );
}

/**
 * The tail as a button: hovering, focusing, or tapping it shows the full ID
 * in a popover, and a click or Enter copies it. An artifact's or an
 * installation's says which it is.
 */
export function CopyableIdTail({
  id: value,
  kind,
  className,
}: {
  readonly id: string;
  readonly kind: IdKind;
  /** Overrides the tail's size and color where it shows alone. */
  readonly className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const { noun, title } = NAMES[kind];

  const copy = async (touch: boolean) => {
    clearTimeout(timer.current);
    setOpen(true);
    try {
      await navigator.clipboard.writeText(value);
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
              aria-label={`Copy ${noun} ${value}`}
              translate="no"
              className={cn(
                TAIL_CLASS,
                // A 44 px tall touch target on a phone, as an ID copy is: the
                // button stays unclipped so its touch area reaches past it.
                "relative inline-flex shrink-0 cursor-copy touch-manipulation rounded-sm outline-none transition-colors after:absolute after:inset-x-0 after:-inset-y-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:after:hidden motion-reduce:transition-none",
                className,
              )}
              onClick={onClick}
            />
          }
        >
          <span className={clipOf(value)}>{value}</span>
        </TooltipTrigger>
        <TooltipContent
          className="max-w-80 flex-col items-start gap-0.5"
          id={`${id}-full`}
          role="tooltip"
        >
          {title ? <p className="text-background/70">{title}</p> : null}
          <p
            translate="no"
            className="break-all font-mono text-xs tabular-nums"
          >
            {value}
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
          ? `${title ?? "ID"} copied`
          : copied === "failed"
            ? `Couldn't copy the ${noun}`
            : ""}
      </span>
    </>
  );
}
