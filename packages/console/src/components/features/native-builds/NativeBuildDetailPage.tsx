import { Link } from "@tanstack/react-router";
import { AlertTriangle, ChevronLeft, HardDrive, RefreshCw } from "lucide-react";

import { PlatformIcon } from "@/components/PlatformIcon";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { type KeysetPage, useNativeBuildDetailQuery } from "@/lib/api";
import {
  formatByteSize,
  nativeBuildArtifacts,
  platformLabel,
} from "@/lib/native-builds";

import { BuiltInBundleCard } from "./BuiltInBundleCard";
import { InstallCard } from "./InstallCard";
import { PatchesCard } from "./PatchesCard";
import { ServedNowCard } from "./ServedNowCard";

export interface NativeBuildDetailSearch {
  /** Patches older than this target bundle: the next page. */
  readonly patchesBefore?: string;
  /** Patches newer than this target bundle: the previous page. */
  readonly patchesAfter?: string;
}

/**
 * One native build: how to install it, its built-in bundle as the base its
 * OTAs patch from, what an install is served now, and the patches from it.
 * The patch page is in the URL, so a link opens it.
 */
export function NativeBuildDetailPage({
  buildId,
  search,
  onSearchChange,
}: {
  readonly buildId: string;
  readonly search: NativeBuildDetailSearch;
  readonly onSearchChange: (search: NativeBuildDetailSearch) => void;
}) {
  const query = useNativeBuildDetailQuery(buildId);
  const detail = query.data;
  const page: KeysetPage = {
    ...(search.patchesBefore === undefined
      ? {}
      : { before: search.patchesBefore }),
    ...(search.patchesAfter === undefined
      ? {}
      : { after: search.patchesAfter }),
  };

  return (
    <div className="flex h-svh min-h-0 flex-col">
      <header className="sticky top-0 z-10 flex shrink-0 items-center gap-x-2 border-b bg-background px-3 py-3 sm:min-h-12 sm:bg-card/70 sm:px-4 sm:backdrop-blur-sm">
        <SidebarTrigger className="-ml-1 size-11 lg:size-7" />
        <Link
          className={buttonVariants({
            className: "min-h-11 sm:min-h-7",
            size: "sm",
            variant: "ghost",
          })}
          to="/native-builds"
        >
          <ChevronLeft data-icon="inline-start" />
          Native builds
        </Link>
        {detail ? (
          <h1 className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
            <PlatformIcon
              className="size-3.5 shrink-0 text-muted-foreground"
              platform={detail.build.platform}
            />
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {platformLabel(detail.build.platform)}{" "}
              {nativeBuildArtifacts[detail.build.artifact_kind].label} ·{" "}
              <span translate="no">{detail.channel}</span>
            </span>
            <span className="hidden text-xs font-normal text-muted-foreground tabular-nums sm:inline">
              {formatByteSize(detail.build.byte_size)}
            </span>
          </h1>
        ) : (
          <h1 className="sr-only">Native build</h1>
        )}
      </header>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-muted/5 p-3 sm:p-6">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 sm:gap-6">
          {query.isError ? (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>The native build couldn't be loaded</AlertTitle>
              <AlertDescription>{query.error.message}</AlertDescription>
              <AlertAction>
                <Button
                  onClick={() => void query.refetch()}
                  size="xs"
                  variant="outline"
                >
                  <RefreshCw data-icon="inline-start" />
                  Retry
                </Button>
              </AlertAction>
            </Alert>
          ) : detail === undefined ? (
            <>
              <span className="sr-only">Loading the native build</span>
              <Skeleton className="h-56 w-full rounded-xl" />
              <Skeleton className="h-64 w-full rounded-xl" />
            </>
          ) : detail === null ? (
            <Empty className="border py-16">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <HardDrive />
                </EmptyMedia>
                <EmptyTitle>Native build not found</EmptyTitle>
                <EmptyDescription>
                  No native build has this ID. It may have been deleted with{" "}
                  <code className="font-mono">native-build delete</code>, or be
                  from another console.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Link
                  className={buttonVariants({
                    className: "min-h-11 sm:min-h-8",
                    variant: "outline",
                  })}
                  to="/native-builds"
                >
                  Show all native builds
                </Link>
              </EmptyContent>
            </Empty>
          ) : (
            <>
              <InstallCard build={detail.build} />
              <BuiltInBundleCard detail={detail} />
              <ServedNowCard detail={detail} />
              <PatchesCard
                detail={detail}
                onPage={(next) =>
                  onSearchChange({
                    ...(next.before === undefined
                      ? {}
                      : { patchesBefore: next.before }),
                    ...(next.after === undefined
                      ? {}
                      : { patchesAfter: next.after }),
                  })
                }
                page={page}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
