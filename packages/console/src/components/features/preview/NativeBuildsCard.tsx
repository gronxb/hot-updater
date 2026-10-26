import type { NativeBuildRow } from "@hot-updater/plugin-core";
import {
  AlertTriangle,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  HardDriveDownload,
  QrCode,
  RefreshCw,
} from "lucide-react";

import { HashValueDisplay } from "@/components/HashValueDisplay";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useConfigQuery } from "@/lib/api";
import { getCommitUrl } from "@/lib/git";
import {
  formatByteSize,
  nativeBuildArtifacts,
  nativeBuildTarget,
} from "@/lib/native-builds";
import type { NativeBuildListResult } from "@/lib/server/nativeBuilds";

const NATIVE_BUILD_GUIDE_URL =
  "https://hot-updater.dev/docs/guides/native-build#register-a-build";

function CommitCell({ hash }: { readonly hash: string | null }) {
  const config = useConfigQuery();
  if (hash === null) return <span className="text-muted-foreground">—</span>;
  const url = getCommitUrl(config.data?.console.gitUrl, hash);
  return url === null ? (
    <HashValueDisplay value={hash} maxLength={10} />
  ) : (
    <a
      className="font-mono text-xs underline-offset-4 hover:underline"
      href={url}
      rel="noreferrer"
      target="_blank"
    >
      {hash.slice(0, 7)}
    </a>
  );
}

/**
 * The registered native builds, newest first, one page at a time. Each row
 * opens the build's install dialog.
 */
export function NativeBuildsCard({
  builds,
  channelName,
  paged,
  onInstall,
  onPage,
}: {
  readonly builds: {
    readonly data: NativeBuildListResult | undefined;
    readonly isError: boolean;
    readonly isLoading: boolean;
    readonly isPlaceholderData: boolean;
    readonly refetch: () => unknown;
  };
  readonly channelName: (channelId: string) => string;
  /** Whether the list shows a page other than the newest. */
  readonly paged: boolean;
  readonly onInstall: (build: NativeBuildRow) => void;
  readonly onPage: (page: { before?: string; after?: string }) => void;
}) {
  const rows = builds.data?.data;
  const { next, previous } = builds.data ?? {};

  return (
    <Card className="overflow-hidden shadow-sm">
      <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3">
        <CardTitle className="text-sm">
          <h2>Native builds</h2>
        </CardTitle>
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
      </CardHeader>
      <CardContent className="p-0">
        {builds.isError ? (
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
        ) : (
          <Table
            aria-busy={builds.isPlaceholderData}
            aria-label="Native builds"
            className="table-fixed"
          >
            <TableHeader>
              <TableRow>
                <TableHead>Build</TableHead>
                <TableHead className="hidden w-32 md:table-cell">
                  Channel
                </TableHead>
                <TableHead className="hidden w-24 lg:table-cell">
                  Commit
                </TableHead>
                <TableHead className="hidden w-32 sm:table-cell">
                  Created
                </TableHead>
                <TableHead className="w-28 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {builds.isLoading ? (
                Array.from({ length: 3 }, (_, index) => (
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
                      <Skeleton className="h-3.5 w-14" />
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <Skeleton className="h-3.5 w-20" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="ml-auto h-6 w-16" />
                    </TableCell>
                  </TableRow>
                ))
              ) : rows?.length === 0 ? (
                <TableRow>
                  <TableCell
                    className="h-44 text-center text-muted-foreground"
                    colSpan={5}
                  >
                    <div className="mx-auto flex max-w-sm flex-col items-center gap-2 whitespace-normal">
                      <HardDriveDownload className="size-5" />
                      <p className="font-medium text-foreground">
                        {paged ? "No more native builds" : "No native builds"}
                      </p>
                      {paged ? (
                        <Button
                          className="mt-1 min-h-11 sm:min-h-8"
                          onClick={() => onPage({})}
                          variant="outline"
                        >
                          Show the newest builds
                        </Button>
                      ) : (
                        <>
                          <p>
                            Build a release app with{" "}
                            <code className="font-mono text-xs">
                              hot-updater native-build android
                            </code>{" "}
                            or{" "}
                            <code className="font-mono text-xs">
                              native-build ios
                            </code>
                            , which tracks it here.
                          </p>
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
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                rows?.map((build) => {
                  const target = nativeBuildTarget(build);
                  const channel = channelName(build.channel_id);
                  return (
                    <TableRow key={build.id}>
                      <TableCell className="py-3 whitespace-normal">
                        <div className="flex min-w-0 flex-col gap-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <PlatformIcon
                              className="size-3.5 shrink-0 text-muted-foreground"
                              platform={build.platform}
                            />
                            <span className="font-medium">
                              {build.platform === "ios" ? "iOS" : "Android"}
                            </span>
                            <Badge variant="secondary">
                              {nativeBuildArtifacts[build.artifact_kind].label}
                            </Badge>
                            <span className="text-xs text-muted-foreground tabular-nums">
                              {formatByteSize(build.byte_size)}
                            </span>
                          </div>
                          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                            <span>{target.label}</span>
                            <HashValueDisplay
                              maxLength={
                                target.label === "App version" ? 24 : 12
                              }
                              value={target.value}
                            />
                            <span className="md:hidden" translate="no">
                              · {channel}
                            </span>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <Badge
                          className="max-w-full truncate"
                          translate="no"
                          variant="outline"
                        >
                          {channel}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        <CommitCell hash={build.git_commit_hash} />
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <TimestampDisplay uuid={build.id} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          aria-label={`Install the ${build.platform === "ios" ? "iOS" : "Android"} build of ${channel}`}
                          className="min-h-11 sm:min-h-7"
                          onClick={() => onInstall(build)}
                          size="sm"
                          variant="outline"
                        >
                          {build.artifact_kind === "apk" ? (
                            <QrCode data-icon="inline-start" />
                          ) : (
                            <HardDriveDownload data-icon="inline-start" />
                          )}
                          Install
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        )}
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
      </CardContent>
    </Card>
  );
}
