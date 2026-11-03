import type { NativeBuildRow } from "@hot-updater/plugin-core";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Download,
  HardDriveDownload,
  RefreshCw,
} from "lucide-react";
import type { MouseEvent } from "react";

import { ChannelBadge } from "@/components/ChannelBadge";
import {
  DataCard,
  DataCardField,
  DataCardSkeletons,
  DataTable,
  DataTableFrame,
  DataTableFullRow,
  DataTablePagination,
  DataTableRow,
  DataTableSkeletonRows,
} from "@/components/DataTable";
import { PlatformLabel } from "@/components/PlatformIcon";
import {
  BuildKeyDisplay,
  NoValue,
  TargetDisplay,
} from "@/components/TargetDisplay";
import { TimestampDisplay } from "@/components/TimestampDisplay";
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
import {
  formatByteSize,
  nativeBuildArtifacts,
  nativeBuildChannel,
  nativeBuildDownloadPath,
  nativeBuildFileName,
  platformLabel,
} from "@/lib/native-builds";
import type { NativeBuildListResult } from "@/lib/server/nativeBuilds";

import { CommitLink } from "./CommitLink";
import { CopyableText } from "./CopyableText";
import { IMPORT_COMMAND, IMPORT_GUIDE_URL } from "./ImportBuild";
import { isSubmitted, StoreSubmissionBadge } from "./StoreSubmission";

export const NATIVE_BUILD_GUIDE_URL =
  "https://hot-updater.dev/docs/guides/native-build#how-a-build-is-tracked";

const COLUMNS = 12;

/** Keeps a click on a control inside a row from opening the build. */
const stop = (event: MouseEvent) => event.stopPropagation();

function EmptyState({
  channel,
  paged,
  onClearChannel,
  onNewest,
}: {
  readonly channel: string | undefined;
  readonly paged: boolean;
  readonly onClearChannel: () => void;
  readonly onNewest: () => void;
}) {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-2 whitespace-normal">
      <HardDriveDownload aria-hidden="true" className="size-5" />
      {paged ? (
        <>
          <p className="font-medium text-foreground">No more native builds</p>
          <Button
            className="mt-1 min-h-11 sm:min-h-8"
            onClick={onNewest}
            variant="outline"
          >
            Show the newest builds
          </Button>
        </>
      ) : channel !== undefined ? (
        <>
          <p className="font-medium text-foreground">
            No native build embeds <span translate="no">{channel}</span>
          </p>
          <p>
            A build embeds the channel it was built on. Build one on this
            channel, or list every channel's builds.
          </p>
          <Button
            className="mt-1 min-h-11 sm:min-h-8"
            onClick={onClearChannel}
            variant="outline"
          >
            Show all channels
          </Button>
        </>
      ) : (
        <>
          <p className="font-medium text-foreground">No native builds</p>
          <p>
            Build one with{" "}
            <code className="font-mono text-xs">native-build android</code> or{" "}
            <code className="font-mono text-xs">native-build ios</code>, or
            import one built elsewhere:
          </p>
          <div className="w-full text-left">
            <CopyableText
              label="the import command"
              value={IMPORT_COMMAND}
              wrap
            />
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
        </>
      )}
    </div>
  );
}

/** What a build is: its platform's name and artifact kind, such as "Android APK". */
const buildTitle = (build: NativeBuildRow) =>
  `${platformLabel(build.platform)} ${nativeBuildArtifacts[build.artifact_kind].label}`;

function BuildLink({ build }: { readonly build: NativeBuildRow }) {
  return (
    <Link
      className="font-medium whitespace-nowrap underline-offset-4 hover:underline"
      onClick={stop}
      params={{ buildId: build.id }}
      to="/native-builds/$buildId"
    >
      {buildTitle(build)}
    </Link>
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
      className="rounded-md text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      onClick={(event) => {
        event.stopPropagation();
        onChannel(channel);
      }}
      type="button"
    >
      <ChannelBadge channel={channel} className="whitespace-nowrap" />
    </button>
  );
}

/** The store track a build went to, and the store build mark. */
function StoreCell({ build }: { readonly build: NativeBuildRow }) {
  if (!isSubmitted(build) && build.store_build !== true) return <NoValue />;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <StoreSubmissionBadge build={build} />
      {build.store_build === true ? (
        <Badge variant="secondary">Store build</Badge>
      ) : null}
    </span>
  );
}

function DownloadButton({ build }: { readonly build: NativeBuildRow }) {
  return (
    <a
      aria-label={`Download ${nativeBuildFileName(build)}`}
      className={buttonVariants({
        className: "min-h-11 sm:min-h-7",
        size: "sm",
        variant: "outline",
      })}
      download
      href={nativeBuildDownloadPath(build.id)}
      onClick={stop}
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

/** The built-in bundle's whole ID: never cut, since it names the base. */
function BuiltInBundleId({ build }: { readonly build: NativeBuildRow }) {
  return (
    <span
      className="font-mono text-xs [overflow-wrap:anywhere] text-muted-foreground"
      translate="no"
    >
      {build.min_bundle_id}
    </span>
  );
}

function BuildRow({
  build,
  onChannel,
}: {
  readonly build: NativeBuildRow;
  readonly onChannel: (channel: string) => void;
}) {
  const navigate = useNavigate();
  const channel = nativeBuildChannel(build);
  return (
    <DataTableRow
      onClick={() =>
        void navigate({
          to: "/native-builds/$buildId",
          params: { buildId: build.id },
        })
      }
    >
      <TableCell>
        <BuildLink build={build} />
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
      <TableCell>
        <BuiltInBundleId build={build} />
      </TableCell>
      <TableCell>
        <CommitLink hash={build.git_commit_hash} />
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <TimestampDisplay uuid={build.id} />
      </TableCell>
      <TableCell className="text-right">
        <DownloadButton build={build} />
      </TableCell>
    </DataTableRow>
  );
}

/** A build's card on a narrow screen, with the same values as its row. */
function BuildCard({
  build,
  onChannel,
}: {
  readonly build: NativeBuildRow;
  readonly onChannel: (channel: string) => void;
}) {
  const navigate = useNavigate();
  const channel = nativeBuildChannel(build);
  return (
    <DataCard
      aria-label={`Native build ${buildTitle(build)} ${build.id}`}
      onClick={() =>
        void navigate({
          to: "/native-builds/$buildId",
          params: { buildId: build.id },
        })
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <BuildLink build={build} />
          <TimestampDisplay uuid={build.id} />
        </div>
        <ChannelFilterButton channel={channel} onChannel={onChannel} />
      </div>
      <dl className="grid grid-cols-2 gap-3 text-xs">
        <DataCardField label="Platform" valueClassName="font-medium">
          <PlatformLabel platform={build.platform} />
        </DataCardField>
        <DataCardField label="Build">
          <BuildNumber build={build} />
        </DataCardField>
        <DataCardField className="col-span-2" label="Target">
          <TargetDisplay
            appVersion={build.app_version}
            fingerprintHash={build.fingerprint_hash}
          />
        </DataCardField>
        <DataCardField className="col-span-2" label="Build key">
          <BuildKeyDisplay value={build.build_key} />
        </DataCardField>
        <DataCardField className="col-span-2" label="Built-in bundle">
          <BuiltInBundleId build={build} />
        </DataCardField>
        <DataCardField label="Commit">
          <CommitLink hash={build.git_commit_hash} />
        </DataCardField>
        <DataCardField label="Size" valueClassName="tabular-nums">
          {formatByteSize(build.byte_size)}
        </DataCardField>
        <DataCardField className="col-span-2" label="Store">
          <StoreCell build={build} />
        </DataCardField>
      </dl>
      <div className="flex justify-end">
        <DownloadButton build={build} />
      </div>
    </DataCard>
  );
}

/**
 * The registered native builds, newest first, one page at a time, as a
 * column table like Bundles' on wide screens and cards on narrow ones. A
 * row opens the build's page; its channel filters the list by that channel.
 */
export function NativeBuildsTable({
  builds,
  channel,
  paged,
  onChannel,
  onPage,
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
  readonly onChannel: (channel: string | undefined) => void;
  readonly onPage: (page: { before?: string; after?: string }) => void;
}) {
  const isMobile = useIsMobile();
  const rows = builds.data?.data;
  const { next, previous } = builds.data ?? {};

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
      onNewest={() => onPage({})}
      paged={paged}
    />
  );

  return (
    <>
      <DataTableFrame>
        {isMobile ? (
          <div
            aria-busy={builds.isPlaceholderData}
            aria-label="Native builds"
            className="h-full overflow-y-auto"
            role="list"
          >
            {builds.isLoading ? (
              <DataCardSkeletons label="Loading native builds" />
            ) : rows?.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">
                {empty}
              </div>
            ) : (
              rows?.map((build) => (
                <div key={build.id} role="listitem">
                  <BuildCard build={build} onChannel={onChannel} />
                </div>
              ))
            )}
          </div>
        ) : (
          <DataTable
            aria-busy={builds.isPlaceholderData}
            aria-label="Native builds"
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
                <TableHead>Built-in bundle</TableHead>
                <TableHead>Commit</TableHead>
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
              <DataTableFullRow className="h-44" columns={COLUMNS}>
                {empty}
              </DataTableFullRow>
            ) : (
              rows?.map((build) => (
                <BuildRow build={build} key={build.id} onChannel={onChannel} />
              ))
            )}
          </DataTable>
        )}
      </DataTableFrame>
      {builds.isLoading || rows === undefined ? null : (
        <DataTablePagination count={rows.length} label="Native build pages">
          <Button
            className="h-8 flex-1 px-3 text-xs sm:flex-none"
            disabled={previous === undefined || builds.isPlaceholderData}
            onClick={() => onPage({ after: previous })}
            size="sm"
            variant="outline"
          >
            <ChevronLeft data-icon="inline-start" />
            Newer
          </Button>
          <Button
            className="h-8 flex-1 px-3 text-xs sm:flex-none"
            disabled={next === undefined || builds.isPlaceholderData}
            onClick={() => onPage({ before: next })}
            size="sm"
            variant="outline"
          >
            Older
            <ChevronRight data-icon="inline-end" />
          </Button>
        </DataTablePagination>
      )}
    </>
  );
}
