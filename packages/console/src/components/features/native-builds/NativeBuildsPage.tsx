import { AlertTriangle, HardDrive, RefreshCw } from "lucide-react";

import { ChannelPicker } from "@/components/ChannelPicker";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useChannelsQuery, useNativeBuildsQuery } from "@/lib/api";
import { ALL_CHANNELS } from "@/lib/constants";
import {
  type NativeBuildsSearch,
  resolveNativeBuildsSearch,
} from "@/routes/-native-builds-search";

import { ImportBuildDialog } from "./ImportBuild";
import { NativeBuildsNav } from "./NativeBuildsNav";
import { NativeBuildsTable } from "./NativeBuildsTable";

/**
 * The list while its channel is unknown: loading, whatever the cache holds,
 * and nothing to refresh. A disabled query still reads when refetched.
 */
const PENDING_BUILDS = {
  data: undefined,
  isError: false,
  isPending: true,
  isPlaceholderData: false,
  refetch: () => undefined,
} as const;

/**
 * The native builds Hot Updater tracks: one page at a time, newest first,
 * those that embed one channel, the default one unless the URL names another
 * or every channel. The page and the channel are in the URL, so a pull
 * request links to its channel's builds.
 */
export function NativeBuildsPage({
  search,
  onSearchChange,
}: {
  readonly search: NativeBuildsSearch;
  readonly onSearchChange: (search: NativeBuildsSearch) => void;
}) {
  // The default channel's input; the rows decode their channel from its ID.
  const channels = useChannelsQuery();
  const channelNames = channels.data?.map(({ name }) => name) ?? [];
  // The page the list shows: a URL without a channel opens on the default
  // one, known once the channel list arrives. A loaded list outlives a failed
  // refresh; without one, the default page waits, and nothing reads every
  // channel in its place.
  const page = resolveNativeBuildsSearch(search, channels.data && channelNames);
  const pending = page === undefined;
  const channelsFailed = pending && channels.isError;
  const { channel, before, after } = page ?? search;
  // Nothing reads every channel's builds on the way to the default channel's.
  const query = useNativeBuildsQuery(page ?? {}, { enabled: !pending });
  const builds = pending ? PENDING_BUILDS : query;
  const filterBy = (next: string | undefined) =>
    onSearchChange(
      next === undefined ? { channels: ALL_CHANNELS } : { channel: next },
    );

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
        <NativeBuildsNav current="builds" />
        <div className="flex flex-wrap items-center gap-2">
          <ChannelPicker
            allChannels
            className="max-sm:min-w-0 max-sm:basis-full"
            onValueChange={filterBy}
            pending={pending}
            value={channel}
          />
          <div className="ml-auto">
            <ImportBuildDialog />
          </div>
          <Button
            aria-label="Refresh native builds"
            className="size-11 sm:size-7"
            disabled={builds.isPending}
            onClick={() => void builds.refetch()}
            size="icon-sm"
            variant="ghost"
          >
            <RefreshCw aria-hidden="true" />
          </Button>
        </div>
        {channelsFailed ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>Channels couldn't be loaded</AlertTitle>
            <AlertDescription>
              Native builds show once the channels load.
            </AlertDescription>
            <AlertAction>
              <Button
                className="min-h-11 sm:min-h-7"
                onClick={() => void channels.refetch()}
                size="xs"
                variant="outline"
              >
                <RefreshCw data-icon="inline-start" />
                Retry
              </Button>
            </AlertAction>
          </Alert>
        ) : (
          <NativeBuildsTable
            builds={builds}
            channel={channel}
            onChannel={filterBy}
            paged={before !== undefined || after !== undefined}
          />
        )}
      </div>
    </div>
  );
}
