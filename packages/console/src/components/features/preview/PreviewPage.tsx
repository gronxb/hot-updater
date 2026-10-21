import type { NativeBuildRow } from "@hot-updater/plugin-core";
import { MonitorSmartphone } from "lucide-react";
import { useMemo } from "react";

import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  type NativeBuildPage,
  useChannelsQuery,
  useConfigQuery,
  useNativeBuildsQuery,
} from "@/lib/api";

import { ChannelLinkCard } from "./ChannelLinkCard";
import { InstallBuildDialog } from "./InstallBuildDialog";
import { NativeBuildsCard } from "./NativeBuildsCard";

export interface PreviewSearch extends NativeBuildPage {
  /** The build whose install dialog is open. */
  readonly build?: string;
  /** The channel whose link shows. */
  readonly channel?: string;
}

/**
 * Preview: install a registered native build, then switch it to a pull
 * request's channel with that channel's link. Everything the page shows is
 * in its URL, so a link can open a build or a channel directly.
 */
export function PreviewPage({
  search,
  onSearchChange,
}: {
  readonly search: PreviewSearch;
  readonly onSearchChange: (search: PreviewSearch) => void;
}) {
  const { build: buildId, channel, before, after } = search;
  const builds = useNativeBuildsQuery({
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  });
  const channels = useChannelsQuery();
  const config = useConfigQuery();
  const channelNames = useMemo(
    () =>
      new Map((channels.data ?? []).map((row) => [row.id, row.name] as const)),
    [channels.data],
  );
  const channelName = (channelId: string) =>
    channelNames.get(channelId) ?? channelId.replace(/^channel:/, "");
  const listed = builds.data?.data.find(({ id }) => id === buildId);

  return (
    <div className="flex h-svh min-h-0 flex-col">
      <header className="sticky top-0 z-10 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-background px-3 py-3 sm:min-h-12 sm:flex-nowrap sm:bg-card/70 sm:px-4 sm:backdrop-blur-sm">
        <SidebarTrigger className="-ml-1 size-11 lg:size-7" />
        <div className="flex items-center gap-1.5">
          <MonitorSmartphone
            aria-hidden="true"
            className="size-3.5 text-muted-foreground"
          />
          <h1 className="text-sm font-medium">Preview</h1>
        </div>
        <p className="basis-full pl-12 text-xs text-muted-foreground sm:basis-auto sm:pl-0">
          Install a native build, then open a channel's link to load its bundle.
        </p>
      </header>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-muted/5 p-3 sm:p-6">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 sm:gap-6">
          <NativeBuildsCard
            // Refreshing reads the channels too, which name the builds'.
            builds={{
              ...builds,
              refetch: () =>
                Promise.all([builds.refetch(), channels.refetch()]),
            }}
            channelName={channelName}
            paged={before !== undefined || after !== undefined}
            onInstall={(row: NativeBuildRow) =>
              onSearchChange({ ...search, build: row.id })
            }
            onPage={(page) =>
              onSearchChange({
                ...(channel === undefined ? {} : { channel }),
                ...page,
              })
            }
          />
          <ChannelLinkCard
            channel={channel}
            channels={{
              data: channels.data?.map(({ name }) => name),
              isError: channels.isError,
              isPending: channels.isPending,
              refetch: channels.refetch,
            }}
            onChannelChange={(next) =>
              onSearchChange({ ...search, channel: next })
            }
            prefix={config.data?.console.channelLinkPrefix}
            prefixPending={config.isPending}
          />
        </div>
      </div>

      <InstallBuildDialog
        buildId={buildId}
        channelName={channelName}
        listed={listed}
        onClose={() => {
          const { build: _closed, ...rest } = search;
          onSearchChange(rest);
        }}
      />
    </div>
  );
}
