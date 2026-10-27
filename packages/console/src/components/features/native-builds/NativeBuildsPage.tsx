import { HardDrive, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
 * are in the URL, so a pull request links to its channel's builds.
 */
export function NativeBuildsPage({
  search,
  onSearchChange,
}: {
  readonly search: NativeBuildPage;
  readonly onSearchChange: (search: NativeBuildPage) => void;
}) {
  const { channel, before, after } = search;
  const builds = useNativeBuildsQuery(search);
  // The filter's choices; the rows decode their channel from its ID.
  const channels = useChannelsQuery();
  const channelNames = channels.data?.map(({ name }) => name) ?? [];
  // A filtered channel may be gone, or not loaded yet: it stays a choice.
  const choices =
    channel === undefined || channelNames.includes(channel)
      ? channelNames
      : [channel, ...channelNames];
  const filterBy = (next: string | undefined) =>
    onSearchChange(next === undefined ? {} : { channel: next });

  return (
    <div className="flex h-svh min-h-0 flex-col">
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

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-muted/5 p-3 sm:p-6">
        <Card className="mx-auto w-full max-w-6xl overflow-hidden shadow-sm">
          <div className="flex items-center gap-2 border-b px-4 py-3">
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
              value={
                channel === undefined ? ALL_CHANNELS : channelValue(channel)
              }
            >
              <SelectTrigger
                aria-label="Channel"
                className="h-11 min-w-0 flex-1 text-xs sm:h-8 sm:w-48 sm:flex-none"
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
          <CardContent className="p-0">
            <NativeBuildsTable
              builds={builds}
              channel={channel}
              onChannel={filterBy}
              onPage={(page) =>
                onSearchChange({
                  ...(channel === undefined ? {} : { channel }),
                  ...page,
                })
              }
              paged={before !== undefined || after !== undefined}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
