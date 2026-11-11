import {
  extractTimestampFromUUIDv7,
  type NativeBuildRow,
} from "@hot-updater/plugin-core";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowUpRight,
  Download,
  HardDrive,
  RefreshCw,
} from "lucide-react";

import { ChannelBadge } from "@/components/ChannelBadge";
import {
  DataCardCollapsedRows,
  DataTableCollapsedRows,
} from "@/components/CollapsedRows";
import {
  DataCard,
  DataCardSkeletons,
  DataCardsEmpty,
  DataTable,
  DataTableEmpty,
  DataTableFrame,
  DataTableFullRow,
  DataTablePagination,
  DataTableRow,
  DataTableSkeletonRows,
  openOutsideControls,
} from "@/components/DataTable";
import { PlatformIcon, PlatformLabel } from "@/components/PlatformIcon";
import { RelativeTime } from "@/components/RelativeTime";
import {
  BuildKeyDisplay,
  NoValue,
  TargetDisplay,
} from "@/components/TargetDisplay";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { TableCell, TableHead } from "@/components/ui/table";
import { useIsMobile } from "@/hooks/use-mobile";
import { newerBuildsOnPath } from "@/lib/native-build-paths";
import {
  formatByteSize,
  nativeBuildArtifacts,
  nativeBuildChannel,
  nativeBuildDownloadPath,
  nativeBuildFileName,
  platformLabel,
} from "@/lib/native-builds";
import type { NativeBuildListResult } from "@/lib/server/nativeBuilds";

import { CopyableText } from "./CopyableText";
import { IMPORT_COMMAND, IMPORT_GUIDE_URL } from "./ImportBuild";
import { OlderBuildLabel } from "./OlderBuildLabel";
import { SandboxBadge } from "./SandboxBadge";
import { isSubmitted, StoreSubmissionBadge } from "./StoreSubmission";

export const NATIVE_BUILD_GUIDE_URL =
  "https://hot-updater.dev/docs/guides/native-build#how-a-build-is-tracked";

const COLUMNS = 10;

/**
 * The page of the list that shows `channel`'s builds, or every build, with
 * the older builds open when they are.
 */
const channelSearch = (channel: string | undefined, showOlder: boolean) => ({
  ...(channel === undefined ? {} : { channel }),
  ...(showOlder ? { showOlder: true as const } : {}),
});

/** The older builds' group: "1 older build", "2 older builds". */
const OLDER_BUILDS = { one: "older build", other: "older builds" } as const;

function EmptyState({
  channel,
  paged,
  showOlder,
  onClearChannel,
}: {
  readonly channel: string | undefined;
  readonly paged: boolean;
  readonly showOlder: boolean;
  readonly onClearChannel: () => void;
}) {
  if (paged) {
    return (
      <DataTableEmpty icon={HardDrive} title="No more native builds">
        <Link
          className={buttonVariants({
            className: "mt-1 min-h-11 sm:min-h-8",
            variant: "outline",
          })}
          search={channelSearch(channel, showOlder)}
          to="/native-builds"
        >
          Show the newest builds
        </Link>
      </DataTableEmpty>
    );
  }
  if (channel !== undefined) {
    return (
      <DataTableEmpty
        icon={HardDrive}
        title={
          <>
            No native build embeds <span translate="no">{channel}</span>
          </>
        }
      >
        <p>
          A build embeds the channel it was built on. Build one on this channel,
          or list every channel's builds.
        </p>
        <Button
          className="mt-1 min-h-11 sm:min-h-8"
          onClick={onClearChannel}
          variant="outline"
        >
          Show all channels
        </Button>
      </DataTableEmpty>
    );
  }
  return (
    <DataTableEmpty icon={HardDrive} title="No native builds">
      <p>
        Build one with{" "}
        <code className="font-mono text-xs">native-build android</code> or{" "}
        <code className="font-mono text-xs">native-build ios</code>, or import
        one built elsewhere:
      </p>
      <div className="w-full text-left">
        <CopyableText label="the import command" value={IMPORT_COMMAND} wrap />
      </div>
      <a
        className={buttonVariants({
          className: "mt-1 min-h-11 sm:min-h-8",
          variant: "outline",
        })}
        href={NATIVE_BUILD_GUIDE_URL}
        rel="noreferrer"
        target="_blank"
      >
        Native build guide
        <ArrowUpRight data-icon="inline-end" />
      </a>
      <a
        className={buttonVariants({
          className: "min-h-11 sm:min-h-8",
          variant: "outline",
        })}
        href={IMPORT_GUIDE_URL}
        rel="noreferrer"
        target="_blank"
      >
        Import guide
        <ArrowUpRight data-icon="inline-end" />
      </a>
    </DataTableEmpty>
  );
}

/** What a build is: its platform's name and artifact kind, such as "Android APK". */
const buildTitle = (build: NativeBuildRow) =>
  `${platformLabel(build.platform)} ${nativeBuildArtifacts[build.artifact_kind].label}`;

/**
 * The build's artifact kind, such as "IPA", linking to its page. The Platform
 * beside it names the platform; the link's name is the whole build.
 */
function BuildLink({ build }: { readonly build: NativeBuildRow }) {
  return (
    <Link
      aria-label={buildTitle(build)}
      className="relative rounded-sm font-medium whitespace-nowrap text-foreground transition-colors underline-offset-4 after:absolute after:-inset-x-[10px] after:-inset-y-[10px] hover:text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:after:hidden"
      params={{ buildId: build.id }}
      to="/native-builds/$buildId"
    >
      {nativeBuildArtifacts[build.artifact_kind].label}
    </Link>
  );
}

/**
 * What the build is, its artifact kind and whether it is a sandbox build, kept
 * together so the tag never wraps away from the kind it qualifies. In a table
 * cell the tag sits beside the kind, so a sandbox row is as tall as any other,
 * and the cell is capped at its widest short kind ("AAB Sandbox"): only a
 * longer kind, such as a sandbox "Simulator app", puts its tag under it rather
 * than widen the table past its frame. On a card the tag sits beside the kind,
 * under it only when a narrow card has no room.
 */
function BuildIdentity({
  build,
  inTable = false,
}: {
  readonly build: NativeBuildRow;
  readonly inTable?: boolean;
}) {
  if (inTable) {
    return (
      <span className="flex max-w-24 flex-wrap items-center gap-x-1.5 gap-y-1">
        <BuildLink build={build} />
        <SandboxBadge build={build} />
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
      <BuildLink build={build} />
      <SandboxBadge build={build} />
    </span>
  );
}

/** The channel the build embeds; a click lists that channel's builds. */
function ChannelFilterButton({
  channel,
  onChannel,
}: {
  readonly channel: string;
  readonly onChannel: (channel: string) => void;
}) {
  return (
    <button
      aria-label={`Show the builds that embed ${channel}`}
      className="relative flex max-w-full min-w-0 rounded-md text-left after:absolute after:inset-x-0 after:-inset-y-[11px] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:after:hidden"
      onClick={() => onChannel(channel)}
      title={channel}
      type="button"
    >
      {/* A long channel ends in an ellipsis; its tooltip and label name it. */}
      <ChannelBadge channel={channel} className="block max-w-32 truncate" />
    </button>
  );
}

/**
 * The store track a build went to, and under it the store build mark, so a
 * build with both stays one badge wide.
 */
function StoreCell({ build }: { readonly build: NativeBuildRow }) {
  if (!isSubmitted(build) && !build.is_store_build) return <NoValue />;
  return (
    <StoreBadges build={build} className="flex flex-col items-start gap-1" />
  );
}

/** The store badges, laid out by the caller. */
function StoreBadges({
  build,
  className,
}: {
  readonly build: NativeBuildRow;
  readonly className: string;
}) {
  return (
    <span className={className}>
      <StoreSubmissionBadge build={build} />
      {build.is_store_build ? (
        <Badge className="px-1.5" variant="muted">
          Store build
        </Badge>
      ) : null}
    </span>
  );
}

function DownloadButton({ build }: { readonly build: NativeBuildRow }) {
  return (
    <a
      aria-label={`Download ${nativeBuildFileName(build)}`}
      className={buttonVariants({
        className: "min-h-11 sm:min-h-8",
        size: "sm",
        variant: "outline",
      })}
      download
      href={nativeBuildDownloadPath(build.id)}
    >
      <Download data-icon="inline-start" />
      Download
    </a>
  );
}

function BuildNumber({ build }: { readonly build: NativeBuildRow }) {
  return build.build_number ? (
    <span className="font-mono tabular-nums" translate="no">
      {build.build_number}
    </span>
  ) : (
    <NoValue />
  );
}

/** When the build was registered, from its ID. */
const createdAt = (build: NativeBuildRow) =>
  extractTimestampFromUUIDv7(build.id);

function BuildRow({
  build,
  newer,
  onChannel,
}: {
  readonly build: NativeBuildRow;
  /** The newer build on its path that passes it over, if any. */
  readonly newer: NativeBuildRow | undefined;
  readonly onChannel: (channel: string) => void;
}) {
  const navigate = useNavigate();
  const channel = nativeBuildChannel(build);
  return (
    <DataTableRow
      aria-label={`Open native build ${build.id}`}
      className="data-[older=true]:bg-muted/35 data-[older=true]:saturate-50 data-[older=true]:hover:bg-muted/50 data-[older=true]:hover:saturate-100 data-[older=true]:focus-within:saturate-100"
      data-older={newer === undefined ? undefined : true}
      onOpen={() =>
        void navigate({
          to: "/native-builds/$buildId",
          params: { buildId: build.id },
        })
      }
    >
      <TableCell>
        <BuildIdentity build={build} inTable />
      </TableCell>
      <TableCell>
        <ChannelFilterButton channel={channel} onChannel={onChannel} />
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <PlatformLabel platform={build.platform} />
      </TableCell>
      <TableCell>
        <BuildNumber build={build} />
      </TableCell>
      <TableCell>
        <TargetDisplay
          appVersion={build.app_version}
          fingerprintHash={build.fingerprint_hash}
        />
      </TableCell>
      <TableCell>
        <BuildKeyDisplay value={build.build_key} />
      </TableCell>
      <TableCell>
        <StoreCell build={build} />
      </TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">
        {formatByteSize(build.byte_size)}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {newer === undefined ? (
          <RelativeTime ms={createdAt(build)} />
        ) : (
          <span className="flex flex-col items-start gap-1">
            <RelativeTime ms={createdAt(build)} />
            <OlderBuildLabel newer={newer} />
          </span>
        )}
      </TableCell>
      <TableCell className="text-right">
        <DownloadButton build={build} />
      </TableCell>
    </DataTableRow>
  );
}

/**
 * A build's card on a narrow screen, scannable a few to a screen: what it is
 * and where, then when, then its target and build key, then its store. Every
 * value of the row is on it, and a tap opens the build's page.
 */
function BuildCard({
  build,
  newer,
  onChannel,
}: {
  readonly build: NativeBuildRow;
  /** The newer build on its path that passes it over, if any. */
  readonly newer: NativeBuildRow | undefined;
  readonly onChannel: (channel: string) => void;
}) {
  const navigate = useNavigate();
  const channel = nativeBuildChannel(build);
  const stored = isSubmitted(build) || build.is_store_build;
  return (
    <DataCard
      aria-label={`Native build ${buildTitle(build)} ${build.id}`}
      className="gap-3 border-b-0 data-[older=true]:bg-muted/35 data-[older=true]:saturate-50 data-[older=true]:hover:bg-muted/50 data-[older=true]:hover:saturate-100 data-[older=true]:focus-within:saturate-100"
      data-older={newer === undefined ? undefined : true}
      onClick={openOutsideControls(
        () =>
          void navigate({
            to: "/native-builds/$buildId",
            params: { buildId: build.id },
          }),
      )}
    >
      {/* What the build is and its download on one line, its channel under it. */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-x-2.5">
          <PlatformIcon
            className="size-4 shrink-0 text-muted-foreground"
            platform={build.platform}
          />
          <BuildIdentity build={build} />
          {newer === undefined ? null : <OlderBuildLabel newer={newer} />}
        </div>
        <DownloadButton build={build} />
      </div>
      <div className="flex min-w-0">
        <ChannelFilterButton channel={channel} onChannel={onChannel} />
      </div>
      <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
        <span className="sr-only">{platformLabel(build.platform)}</span>
        {build.build_number ? (
          <>
            <span translate="no">
              Build{" "}
              <span className="font-mono tabular-nums text-foreground">
                {build.build_number}
              </span>
            </span>
            <span aria-hidden="true">·</span>
          </>
        ) : null}
        <span className="tabular-nums">{formatByteSize(build.byte_size)}</span>
        <span aria-hidden="true">·</span>
        <RelativeTime ms={createdAt(build)} />
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-6 text-xs">
        <span className="flex items-center">
          <span className="sr-only">Target </span>
          <TargetDisplay
            appVersion={build.app_version}
            fingerprintHash={build.fingerprint_hash}
          />
        </span>
        {build.build_key ? (
          <span className="flex items-center">
            <span className="sr-only">Build key </span>
            <BuildKeyDisplay value={build.build_key} />
          </span>
        ) : null}
      </div>
      {stored ? (
        <StoreBadges
          build={build}
          className="flex flex-wrap items-center gap-1.5"
        />
      ) : null}
    </DataCard>
  );
}

/**
 * The registered native builds, newest first, one page at a time, as a
 * column table like Bundles' on wide screens and cards on narrow ones. A
 * row opens the build's page; its channel filters the list by that channel.
 * The newest build of each distribution path leads; the page's older ones
 * collapse under them into one group, shaded when it opens.
 */
export function NativeBuildsTable({
  builds,
  channel,
  paged,
  showOlder = false,
  onChannel,
  onShowOlderChange,
}: {
  readonly builds: {
    readonly data: NativeBuildListResult | undefined;
    readonly isError: boolean;
    readonly isLoading: boolean;
    readonly isPlaceholderData: boolean;
    readonly refetch: () => unknown;
  };
  /** The channel the list is filtered by. */
  readonly channel: string | undefined;
  /** Whether the list shows a page other than the newest. */
  readonly paged: boolean;
  /** Whether the page's older builds show, as the URL keeps it. */
  readonly showOlder?: boolean;
  readonly onChannel: (channel: string | undefined) => void;
  readonly onShowOlderChange: (open: boolean) => void;
}) {
  const isMobile = useIsMobile();
  const rows = builds.data?.data;
  const { next, previous } = builds.data ?? {};
  const newer = newerBuildsOnPath(rows ?? []);
  const newest = rows?.filter((build) => !newer.has(build.id)) ?? [];
  const older = rows?.filter((build) => newer.has(build.id)) ?? [];
  const group = {
    count: older.length,
    noun: OLDER_BUILDS,
    open: showOlder,
    onOpenChange: onShowOlderChange,
  };

  if (builds.isError) {
    return (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>Native builds couldn't be loaded</AlertTitle>
        <AlertDescription>
          Check your connection and try again.
        </AlertDescription>
        <AlertAction>
          <Button
            onClick={() => void builds.refetch()}
            size="xs"
            variant="outline"
          >
            <RefreshCw data-icon="inline-start" />
            Retry
          </Button>
        </AlertAction>
      </Alert>
    );
  }

  const empty = (
    <EmptyState
      channel={channel}
      onClearChannel={() => onChannel(undefined)}
      paged={paged}
      showOlder={showOlder}
    />
  );

  return (
    <>
      <DataTableFrame>
        {isMobile ? (
          <div
            aria-busy={builds.isPlaceholderData}
            aria-label="Native builds"
            className="h-full overflow-y-auto aria-busy:opacity-60"
            role="list"
          >
            {builds.isLoading ? (
              <DataCardSkeletons label="Loading native builds" />
            ) : rows?.length === 0 ? (
              <DataCardsEmpty>{empty}</DataCardsEmpty>
            ) : (
              <>
                {newest.map((build) => (
                  <div
                    className="border-b last:border-b-0"
                    key={build.id}
                    role="listitem"
                  >
                    <BuildCard
                      build={build}
                      newer={undefined}
                      onChannel={onChannel}
                    />
                  </div>
                ))}
                {older.length > 0 ? (
                  <div role="listitem">
                    <DataCardCollapsedRows {...group} />
                  </div>
                ) : null}
                {showOlder
                  ? older.map((build) => (
                      <div
                        className="border-b last:border-b-0"
                        key={build.id}
                        role="listitem"
                      >
                        <BuildCard
                          build={build}
                          newer={newer.get(build.id)}
                          onChannel={onChannel}
                        />
                      </div>
                    ))
                  : null}
              </>
            )}
          </div>
        ) : (
          <DataTable
            aria-busy={builds.isPlaceholderData}
            aria-label="Native builds"
            // Ten columns fit 1440 px with 6 px between a cell and its border.
            className="aria-busy:opacity-60 [&_td]:px-1.5 [&_th]:px-1.5"
            header={
              <>
                <TableHead>Artifact</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>Platform</TableHead>
                <TableHead>Build</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Build key</TableHead>
                <TableHead>Store</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </>
            }
          >
            {builds.isLoading ? (
              <DataTableSkeletonRows
                columns={COLUMNS}
                label="Loading native builds"
              />
            ) : rows?.length === 0 ? (
              <DataTableFullRow columns={COLUMNS}>{empty}</DataTableFullRow>
            ) : (
              <>
                {newest.map((build) => (
                  <BuildRow
                    build={build}
                    key={build.id}
                    newer={undefined}
                    onChannel={onChannel}
                  />
                ))}
                {older.length > 0 ? (
                  <DataTableCollapsedRows columns={COLUMNS} {...group} />
                ) : null}
                {showOlder
                  ? older.map((build) => (
                      <BuildRow
                        build={build}
                        key={build.id}
                        newer={newer.get(build.id)}
                        onChannel={onChannel}
                      />
                    ))
                  : null}
              </>
            )}
          </DataTable>
        )}
      </DataTableFrame>
      {builds.isLoading || rows === undefined ? null : (
        <DataTablePagination
          count={rows.length}
          label="Native build pages"
          pending={builds.isPlaceholderData}
          newest={
            paged
              ? {
                  search: channelSearch(channel, showOlder),
                  to: "/native-builds",
                }
              : undefined
          }
          next={
            next === undefined
              ? undefined
              : {
                  search: {
                    ...channelSearch(channel, showOlder),
                    before: next,
                  },
                  to: "/native-builds",
                }
          }
          previous={
            previous === undefined
              ? undefined
              : {
                  search: {
                    ...channelSearch(channel, showOlder),
                    after: previous,
                  },
                  to: "/native-builds",
                }
          }
        />
      )}
    </>
  );
}
