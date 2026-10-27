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

import {
  HashValueDisplay,
  shortenIdentifier,
} from "@/components/HashValueDisplay";
import { PlatformIcon } from "@/components/PlatformIcon";
import { TimestampDisplay } from "@/components/TimestampDisplay";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatByteSize,
  nativeBuildArtifacts,
  nativeBuildChannel,
  nativeBuildDownloadPath,
  nativeBuildFileName,
  nativeBuildTarget,
  platformLabel,
} from "@/lib/native-builds";
import type { NativeBuildListResult } from "@/lib/server/nativeBuilds";

import { CommitLink } from "./CommitLink";
import { CopyableText } from "./CopyableText";
import { IMPORT_COMMAND, IMPORT_GUIDE_URL } from "./ImportBuild";
import { StoreSubmissionBadge } from "./StoreSubmission";

export const NATIVE_BUILD_GUIDE_URL =
  "https://hot-updater.dev/docs/guides/native-build#register-a-build";

const COLUMNS = 6;

function EmptyRow({
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
    <TableRow>
      <TableCell
        className="h-44 text-center text-muted-foreground"
        colSpan={COLUMNS}
      >
        <div className="mx-auto flex max-w-sm flex-col items-center gap-2 whitespace-normal">
          <HardDriveDownload aria-hidden="true" className="size-5" />
          {paged ? (
            <>
              <p className="font-medium text-foreground">
                No more native builds
              </p>
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
                Build a release app with{" "}
                <code className="font-mono text-xs">
                  hot-updater native-build android
                </code>{" "}
                or <code className="font-mono text-xs">native-build ios</code>,
                which tracks it here, or import one built elsewhere:
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
      </TableCell>
    </TableRow>
  );
}

function LoadingRows() {
  return Array.from({ length: 3 }, (_, index) => (
    <TableRow key={index}>
      <TableCell className="space-y-2 py-3">
        {index === 0 ? (
          <span className="sr-only">Loading native builds</span>
        ) : null}
        <Skeleton className="h-3.5 w-40" />
        <Skeleton className="h-3 w-24" />
      </TableCell>
      <TableCell className="hidden md:table-cell">
        <Skeleton className="h-5 w-20" />
      </TableCell>
      <TableCell className="hidden lg:table-cell">
        <Skeleton className="h-3.5 w-28" />
      </TableCell>
      <TableCell className="hidden xl:table-cell">
        <Skeleton className="h-3.5 w-14" />
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        <Skeleton className="h-3.5 w-20" />
      </TableCell>
      <TableCell>
        <Skeleton className="ml-auto h-6 w-16" />
      </TableCell>
    </TableRow>
  ));
}

function BuildRow({
  build,
  onChannel,
}: {
  readonly build: NativeBuildRow;
  readonly onChannel: (channel: string) => void;
}) {
  const navigate = useNavigate();
  const target = nativeBuildTarget(build);
  const channel = nativeBuildChannel(build);
  const title = `${platformLabel(build.platform)} ${nativeBuildArtifacts[build.artifact_kind].label}`;
  return (
    <TableRow
      className="cursor-pointer"
      onClick={() =>
        void navigate({
          to: "/native-builds/$buildId",
          params: { buildId: build.id },
        })
      }
    >
      <TableCell className="py-3 whitespace-normal">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <PlatformIcon
              className="size-3.5 shrink-0 text-muted-foreground"
              platform={build.platform}
            />
            <Link
              className="font-medium underline-offset-4 hover:underline"
              onClick={(event) => event.stopPropagation()}
              params={{ buildId: build.id }}
              to="/native-builds/$buildId"
            >
              {title}
            </Link>
            <span className="text-xs text-muted-foreground tabular-nums">
              {formatByteSize(build.byte_size)}
            </span>
            <StoreSubmissionBadge build={build} withTime />
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <span>{target.label}</span>
            <HashValueDisplay
              maxLength={target.label === "App version" ? 24 : 12}
              value={target.value}
            />
            {!build.build_number ? null : (
              <span className="tabular-nums" translate="no">
                · build {build.build_number}
              </span>
            )}
            <span className="md:hidden" translate="no">
              · {channel}
            </span>
          </div>
        </div>
      </TableCell>
      <TableCell className="hidden md:table-cell">
        <button
          aria-label={`Show the builds that embed ${channel}`}
          className="max-w-full rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          onClick={(event) => {
            event.stopPropagation();
            onChannel(channel);
          }}
          type="button"
        >
          <Badge
            className="max-w-full truncate"
            translate="no"
            variant="outline"
          >
            {channel}
          </Badge>
        </button>
      </TableCell>
      <TableCell className="hidden lg:table-cell">
        <span
          className="font-mono text-xs text-muted-foreground"
          title={build.min_bundle_id}
          translate="no"
        >
          {shortenIdentifier(build.min_bundle_id, 24)}
        </span>
      </TableCell>
      <TableCell className="hidden xl:table-cell">
        <CommitLink hash={build.git_commit_hash} />
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        <TimestampDisplay uuid={build.id} />
      </TableCell>
      <TableCell className="text-right">
        <a
          aria-label={`Download ${nativeBuildFileName(build)}`}
          className={buttonVariants({
            className: "min-h-11 sm:min-h-7",
            size: "sm",
            variant: "outline",
          })}
          download
          href={nativeBuildDownloadPath(build.id)}
          onClick={(event) => event.stopPropagation()}
        >
          <Download data-icon="inline-start" />
          Download
        </a>
      </TableCell>
    </TableRow>
  );
}

/**
 * The registered native builds, newest first, one page at a time. A row
 * opens the build's page; its channel filters the list by that channel.
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
  const rows = builds.data?.data;
  const { next, previous } = builds.data ?? {};

  if (builds.isError) {
    return (
      <div className="p-4">
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
      </div>
    );
  }

  return (
    <>
      <Table
        aria-busy={builds.isPlaceholderData}
        aria-label="Native builds"
        className="table-fixed"
      >
        <TableHeader>
          <TableRow>
            <TableHead>Build</TableHead>
            <TableHead className="hidden w-32 md:table-cell">Channel</TableHead>
            <TableHead className="hidden w-56 lg:table-cell">
              Built-in bundle
            </TableHead>
            <TableHead className="hidden w-24 xl:table-cell">Commit</TableHead>
            <TableHead className="hidden w-32 sm:table-cell">Created</TableHead>
            <TableHead className="w-32 text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {builds.isLoading ? (
            <LoadingRows />
          ) : rows?.length === 0 ? (
            <EmptyRow
              channel={channel}
              onClearChannel={() => onChannel(undefined)}
              onNewest={() => onPage({})}
              paged={paged}
            />
          ) : (
            rows?.map((build) => (
              <BuildRow build={build} key={build.id} onChannel={onChannel} />
            ))
          )}
        </TableBody>
      </Table>
      {next !== undefined || previous !== undefined ? (
        <nav
          aria-label="Native build pages"
          className="flex items-center justify-end gap-2 border-t px-4 py-2"
        >
          <Button
            className="min-h-11 sm:min-h-7"
            disabled={previous === undefined || builds.isPlaceholderData}
            onClick={() => onPage({ after: previous })}
            size="sm"
            variant="ghost"
          >
            <ChevronLeft data-icon="inline-start" />
            Newer
          </Button>
          <Button
            className="min-h-11 sm:min-h-7"
            disabled={next === undefined || builds.isPlaceholderData}
            onClick={() => onPage({ before: next })}
            size="sm"
            variant="ghost"
          >
            Older
            <ChevronRight data-icon="inline-end" />
          </Button>
        </nav>
      ) : null}
    </>
  );
}
