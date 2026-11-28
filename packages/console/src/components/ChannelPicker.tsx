import { RefreshCw } from "lucide-react";
import { type ComponentProps, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import { Skeleton } from "@/components/ui/skeleton";
import { useChannelsQuery } from "@/lib/api";
import { ALL_CHANNELS_LABEL } from "@/lib/constants";
import { cn } from "@/lib/utils";

/** A choice in the list: a channel's name, or every channel (no name). */
type ChannelChoice = {
  readonly name: string | undefined;
  readonly label: string;
};

/**
 * One look for every filter button: 44 px on a phone, compact from sm, and
 * filled when the filter is narrower than its default.
 */
export function FilterChip({
  className,
  ...props
}: ComponentProps<typeof Button>) {
  return (
    <Button
      className={cn(
        "h-11 shrink-0 gap-1.5 px-3 text-sm data-[active=true]:border-primary/60 data-[active=true]:bg-primary/10 sm:h-8 sm:text-xs",
        className,
      )}
      variant="outline"
      {...props}
    />
  );
}

const EVERY_CHANNEL: ChannelChoice = {
  name: undefined,
  label: ALL_CHANNELS_LABEL,
};

/**
 * How old the cached channel list may be when the list opens. An older one
 * is read again, so a pull request's new channel shows up without a reload;
 * a younger one is shown as it is.
 */
export const CHANNELS_FRESH_MS = 30_000;

/**
 * The channel filter Insights, Bundles, and Native builds share: a button
 * that reads "Channel <name>" and opens a searchable list of the project's
 * channels. Typing narrows the list, and Enter picks the first match.
 *
 * Every channel is one more choice where a page offers it. It is no name,
 * so a channel named `all` stays a channel of its own.
 */
export function ChannelPicker({
  value,
  onValueChange,
  allChannels = false,
  pending = false,
  active,
  className,
}: {
  /** The channel's name; undefined is every channel, where offered. */
  readonly value: string | undefined;
  readonly onValueChange: (name: string | undefined) => void;
  /** Whether "All channels" is a choice. */
  readonly allChannels?: boolean;
  /** Whether the page has yet to decide which channel it shows. */
  readonly pending?: boolean;
  /** Whether the filter is narrower than the page's default. */
  readonly active?: boolean;
  readonly className?: string;
}) {
  const channels = useChannelsQuery();
  const [query, setQuery] = useState("");
  const list = useRef<HTMLDivElement>(null);
  // Whether the list has just opened and still has to start at its top.
  const opening = useRef(false);
  const names = channels.data?.map(({ name }) => name) ?? [];
  // A filtered channel may be gone, or not loaded yet: it stays a choice.
  const shown =
    value === undefined || names.includes(value) ? names : [value, ...names];
  const choices: ChannelChoice[] = [
    ...(allChannels ? [EVERY_CHANNEL] : []),
    ...shown.map((name) => ({ name, label: name })),
  ];
  const typed = query.trim().toLowerCase();
  const matches = choices.filter((choice) =>
    choice.label.toLowerCase().includes(typed),
  );
  const selected =
    choices.find((choice) => choice.name === value) ??
    (value === undefined ? EVERY_CHANNEL : { name: value, label: value });
  const label = pending ? undefined : selected.label;

  return (
    <Combobox
      autoHighlight
      disabled={pending}
      filter={null}
      inputValue={query}
      isItemEqualToValue={(item: ChannelChoice, current: ChannelChoice) =>
        item.name === current.name
      }
      itemToStringLabel={(choice: ChannelChoice) => choice.label}
      items={matches}
      onInputValueChange={setQuery}
      onItemHighlighted={(_, details) => {
        if (!opening.current || details.reason !== "none") return;
        opening.current = false;
        // Opening highlights the current channel, and Base UI scrolls it
        // into view in the next frame. The list starts at its first item
        // instead: the reset runs after that scroll, before the frame paints.
        queueMicrotask(() =>
          requestAnimationFrame(() => {
            if (list.current) list.current.scrollTop = 0;
          }),
        );
      }}
      onOpenChange={(next) => {
        opening.current = next;
        if (!next) {
          setQuery("");
          return;
        }
        // A pull request's channel appears while the page is open, once
        // the cached list is old enough to read again.
        if (
          channels.data !== undefined &&
          !channels.isFetching &&
          Date.now() - channels.dataUpdatedAt > CHANNELS_FRESH_MS
        )
          void channels.refetch();
      }}
      onValueChange={(choice: ChannelChoice | null) => {
        if (choice !== null && choice.name !== value)
          onValueChange(choice.name);
      }}
      value={pending ? null : selected}
    >
      <ComboboxTrigger
        aria-label={label === undefined ? "Channel" : `Channel: ${label}`}
        data-active={active}
        render={<FilterChip className={className} />}
        title={label}
      >
        <span className="text-muted-foreground">Channel</span>
        {label === undefined ? (
          // A failed list leaves nothing to wait for: the page says so.
          channels.isError ? null : (
            <Skeleton className="h-3 w-16" />
          )
        ) : (
          <span
            className="min-w-0 flex-1 truncate text-left sm:max-w-48"
            translate={value === undefined ? undefined : "no"}
          >
            {label}
          </span>
        )}
      </ComboboxTrigger>
      <ComboboxContent className="w-72 min-w-(--anchor-width)">
        <ComboboxInput
          aria-label="Search channels"
          maxLength={1024}
          placeholder="Search channels…"
          showTrigger={false}
        />
        {channels.isPending ? (
          <p className="px-3 pt-2 text-xs text-muted-foreground">
            Loading channels…
          </p>
        ) : channels.isError && channels.data === undefined ? (
          <div className="flex items-center justify-between gap-2 px-3 pt-2 text-xs text-muted-foreground">
            Couldn't load channels.
            <Button
              className="max-md:min-h-11"
              onClick={() => void channels.refetch()}
              size="sm"
              variant="outline"
            >
              <RefreshCw data-icon="inline-start" />
              Retry channels
            </Button>
          </div>
        ) : null}
        <ComboboxEmpty className="flex-col items-center gap-2 px-3">
          {typed === "" ? null : (
            <>
              No channel matches “{query.trim()}”.
              <Button
                className="max-md:min-h-11"
                onClick={() => setQuery("")}
                size="sm"
                variant="outline"
              >
                Clear search
              </Button>
            </>
          )}
        </ComboboxEmpty>
        <ComboboxList ref={list}>
          {(choice: ChannelChoice) => (
            <ComboboxItem key={choice.name ?? ""} value={choice}>
              <span
                className="min-w-0 [overflow-wrap:anywhere]"
                translate={choice.name === undefined ? undefined : "no"}
              >
                {choice.label}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
