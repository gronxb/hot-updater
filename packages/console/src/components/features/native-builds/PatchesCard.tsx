import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  RefreshCw,
} from "lucide-react";

import { ArtifactIdDisplay } from "@/components/ArtifactIdDisplay";
import { ReleaseIdDisplay } from "@/components/ReleaseIdDisplay";
import { TimestampDisplay } from "@/components/TimestampDisplay";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type KeysetPage, useNativeBuildPatchesQuery } from "@/lib/api";
import { formatByteSize, SANDBOX_NO_PATCH_BASE } from "@/lib/native-builds";
import type {
  NativeBuildDetail,
  NativeBuildPatchPage,
} from "@/lib/server/nativeBuilds";

const BUNDLE_DIFFING_GUIDE_URL =
  "https://hot-updater.dev/docs/guides/bundle-diffing#first-ota-update";

type ServedRelease = NativeBuildDetail["servedNow"][number];

/**
 * The release each artifact is served by in the build's scope now: the
 * newest, where a promote serves one artifact twice. Patches belong to
 * artifacts, and the page names them by the release people know, read from
 * the catalog the build's page already holds.
 */
const servingReleases = (
  servedNow: readonly ServedRelease[],
): ReadonlyMap<string, ServedRelease> => {
  const serving = new Map<string, ServedRelease>();
  for (const release of servedNow) {
    if (release.bundleId !== null && !serving.has(release.bundleId)) {
      serving.set(release.bundleId, release);
    }
  }
  return serving;
};

/**
 * A patch's target: the release serving it, named by its label and its
 * release ID, as on the Bundles page. A target the scope no longer serves
 * shows as the artifact it is, linking to the releases of that artifact.
 */
function PatchTarget({
  artifactId,
  release,
}: {
  readonly artifactId: string;
  readonly release: ServedRelease | undefined;
}) {
  if (release !== undefined) {
    return (
      <ReleaseIdDisplay
        releaseId={release.releaseId}
        label={release.label}
        labelAs={
          <Link
            className="underline-offset-4 hover:underline"
            search={{ releaseId: release.releaseId }}
            to="/"
          />
        }
      />
    );
  }
  return (
    <span className="flex min-w-0 flex-col items-start gap-0.5">
      <span className="text-xs text-muted-foreground">Artifact</span>
      <Link
        className="block min-w-0 underline-offset-4 hover:underline"
        search={{ artifactId }}
        to="/"
      >
        <ArtifactIdDisplay artifactId={artifactId} copyable={false} />
      </Link>
    </span>
  );
}

/**
 * The bundles that patch from the build's built-in bundle, newest first, a
 * page at a time: the newest page comes with the build's page, and others
 * are read as they are asked for.
 */
export function PatchesCard({
  detail,
  page,
  onPage,
}: {
  readonly detail: NativeBuildDetail;
  readonly page: KeysetPage;
  readonly onPage: (page: KeysetPage) => void;
}) {
  const paged = page.before !== undefined || page.after !== undefined;
  const query = useNativeBuildPatchesQuery(
    detail.build.min_bundle_id,
    page,
    paged,
  );
  const patches: NativeBuildPatchPage | undefined = paged
    ? query.data
    : detail.patches;
  const { next, previous } = patches ?? {};
  const serving = servingReleases(detail.servedNow);

  return (
    <Card className="overflow-hidden shadow-sm" id="patches">
      <CardHeader className="border-b px-4 py-3">
        <CardTitle className="text-sm">
          <h2>Patches from this build</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {paged && query.isError ? (
          <div className="p-4">
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>Patches couldn't be loaded</AlertTitle>
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
          </div>
        ) : patches === undefined ? (
          <div className="flex flex-col gap-2 p-4">
            <span className="sr-only">Loading patches</span>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : patches.data.length === 0 ? (
          paged ? (
            <Empty className="py-10">
              <EmptyHeader>
                <EmptyTitle>No more patches</EmptyTitle>
              </EmptyHeader>
              <Button
                className="min-h-11 sm:min-h-8"
                onClick={() => onPage({})}
                variant="outline"
              >
                Show the newest patches
              </Button>
            </Empty>
          ) : (
            <Empty className="py-10">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <GitBranch />
                </EmptyMedia>
                <EmptyTitle>No patches from this build</EmptyTitle>
                <EmptyDescription>
                  {detail.build.is_sandbox ? (
                    SANDBOX_NO_PATCH_BASE
                  ) : (
                    <>
                      A deploy adds a patch from this build's bundle while it is
                      its scope's store build, or its newest build with none
                      marked, and the deploy config turns patches on, with{" "}
                      <code className="font-mono">patch</code> in{" "}
                      <code className="font-mono">hot-updater.config.ts</code>.
                    </>
                  )}
                </EmptyDescription>
              </EmptyHeader>
              {detail.build.is_sandbox ? null : (
                <EmptyContent>
                  <a
                    className={buttonVariants({
                      className: "min-h-11 sm:min-h-8",
                      variant: "outline",
                    })}
                    href={BUNDLE_DIFFING_GUIDE_URL}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Bundle diffing guide
                    <ArrowUpRight data-icon="inline-end" />
                  </a>
                </EmptyContent>
              )}
            </Empty>
          )
        ) : (
          <Table
            aria-busy={paged && query.isPlaceholderData}
            aria-label="Patches from this build"
            className="table-fixed"
          >
            <TableHeader>
              <TableRow>
                <TableHead>Target</TableHead>
                <TableHead className="w-28">Patch size</TableHead>
                <TableHead className="hidden w-32 sm:table-cell">
                  Created
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {patches.data.map((patch) => {
                const release = serving.get(patch.bundleId);
                return (
                  <TableRow key={patch.bundleId}>
                    <TableCell className="py-3 whitespace-normal">
                      <PatchTarget
                        artifactId={patch.bundleId}
                        release={release}
                      />
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">
                      {formatByteSize(patch.byteSize)}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      {/* Dated as the row is named: a release by its own
                          ID, as Served now dates it, else the artifact. */}
                      <TimestampDisplay
                        uuid={release?.releaseId ?? patch.bundleId}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {next !== undefined || previous !== undefined ? (
          <nav
            aria-label="Patch pages"
            className="flex items-center justify-end gap-2 border-t px-4 py-2"
          >
            <Button
              className="min-h-11 sm:min-h-7"
              disabled={
                previous === undefined || (paged && query.isPlaceholderData)
              }
              onClick={() => onPage({ after: previous })}
              size="sm"
              variant="ghost"
            >
              <ChevronLeft data-icon="inline-start" />
              Newer
            </Button>
            <Button
              className="min-h-11 sm:min-h-7"
              disabled={
                next === undefined || (paged && query.isPlaceholderData)
              }
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
