import { HardDrive, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  type NativeBuildPage,
  useChannelsQuery,
  useNativeBuildsQuery,
} from "@/lib/api";

import { ImportBuildDialog } from "./ImportBuild";
import { NativeBuildsTable } from "./NativeBuildsTable";

/** The native build list's URL: the page it reads, and how it shows it. */
export type NativeBuildsSearch = NativeBuildPage & {
  /** Whether the builds a newer one on their path passes over show. */
  readonly showOlder?: true;
};

/**
 * The page a list URL reads, its view state left out, so opening the older
 * builds reads nothing: the same query, kept on screen.
 */
const pageOf = ({ channel, before, after }: NativeBuildsSearch) =>
  Object.fromEntries(
    Object.entries({ channel, before, after }).filter(
      ([, value]) => value !== undefined,
    ),
  ) as NativeBuildPage;

/**
 * The filter's values: a channel's is its name behind a prefix, so no channel
 * name, `all` included, can be taken for "All channels".
 */
const ALL_CHANNELS = "all";
const CHANNEL_VALUE_PREFIX = "channel:";
const channelValue = (name: string) => `${CHANNEL_VALUE_PREFIX}${name}`;

/**
 * The native builds Hot Updater tracks: one page at a time, newest first,
 * optionally only those that embed one channel. The page and the channel
 * are in the URL, so a pull request links to its channel's builds, and so
 * is whether the older builds show, which reads nothing.
 */
export function NativeBuildsPage({
  search,
  onSearchChange,
}: {
  readonly search: NativeBuildsSearch;
  readonly onSearchChange: (
    search: NativeBuildsSearch,
    options?: { readonly resetScroll: boolean },
  ) => void;
}) {
  const { channel, before, after, showOlder } = search;
  const builds = useNativeBuildsQuery(pageOf(search));
  // The filter's choices; the rows decode their channel from its ID.
  const channels = useChannelsQuery();
  const channelNames = channels.data?.map(({ name }) => name) ?? [];
  // A filtered channel may be gone, or not loaded yet: it stays a choice.
  const choices =
    channel === undefined || channelNames.includes(channel)
      ? channelNames
      : [channel, ...channelNames];
  const view = showOlder ? { showOlder } : {};
  const filterBy = (next: string | undefined) =>
    onSearchChange(next === undefined ? view : { channel: next, ...view });

  return (
    <div className="flex h-svh min-h-0 min-w-0 flex-col">
      <header className="sticky top-0 z-10 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-background px-3 py-3 sm:min-h-12 sm:flex-nowrap sm:bg-card/70 sm:px-4 sm:backdrop-blur-sm">
        <SidebarTrigger className="-ml-1 size-11 lg:size-7" />
        <div className="flex items-center gap-1.5">
          <HardDrive
            aria-hidden="true"
            className="size-3.5 text-muted-foreground"
          />
          <h1 className="text-sm font-medium">Native builds</h1>
        </div>
        <p className="basis-full pl-12 text-xs text-muted-foreground sm:basis-auto sm:pl-0">
          Store and test builds, each the built-in bundle its OTAs patch from.
        </p>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 bg-muted/5 p-3 sm:p-6">
        <div className="flex items-center gap-2">
          <Select
            items={[
              { label: "All channels", value: ALL_CHANNELS },
              ...choices.map((name) => ({
                label: name,
                value: channelValue(name),
              })),
            ]}
            onOpenChange={(open) => {
              // A pull request's channel appears while the page is open.
              if (open) void channels.refetch();
            }}
            onValueChange={(value) =>
              filterBy(
                value?.startsWith(CHANNEL_VALUE_PREFIX)
                  ? value.slice(CHANNEL_VALUE_PREFIX.length)
                  : undefined,
              )
            }
            value={channel === undefined ? ALL_CHANNELS : channelValue(channel)}
          >
            <SelectTrigger
              aria-label="Channel"
              className="min-w-0 flex-1 text-xs data-[size=default]:h-11 sm:w-48 sm:flex-none sm:data-[size=default]:h-8"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL_CHANNELS}>All channels</SelectItem>
                {choices.map((name) => (
                  <SelectItem
                    key={name}
                    translate="no"
                    value={channelValue(name)}
                  >
                    {name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <div className="ml-auto">
            <ImportBuildDialog />
          </div>
          <Button
            aria-label="Refresh native builds"
            className="size-11 sm:size-7"
            disabled={builds.isLoading}
            onClick={() => void builds.refetch()}
            size="icon-sm"
            variant="ghost"
          >
            <RefreshCw aria-hidden="true" />
          </Button>
        </div>
        <NativeBuildsTable
          builds={builds}
          channel={channel}
          onChannel={filterBy}
          onShowOlderChange={(open) =>
            onSearchChange(
              {
                ...search,
                showOlder: open ? true : undefined,
              },
              { resetScroll: false },
            )
          }
          paged={before !== undefined || after !== undefined}
          showOlder={showOlder === true}
        />
      </div>
    </div>
  );
}
