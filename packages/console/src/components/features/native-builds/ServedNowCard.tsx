import { NUMERIC_COHORT_SIZE } from "@hot-updater/protocol";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, PackageOpen } from "lucide-react";

import { RolloutPercentageBadge } from "@/components/RolloutPercentageBadge";
import { TimestampDisplay } from "@/components/TimestampDisplay";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatByteSize } from "@/lib/native-builds";
import type { NativeBuildDetail } from "@/lib/server/nativeBuilds";

/** How the first OTA to a bundle downloads on this build. */
export type FirstDownload =
  | { readonly kind: "patch"; readonly byteSize: number }
  | { readonly kind: "full" }
  /** The patches page on screen doesn't reach back to the bundle. */
  | { readonly kind: "unknown" };

/**
 * How an install of the build downloads `bundleId` as its first OTA: as the
 * patch from the built-in bundle when one exists, else the full bundle. The
 * newest page of patches decides it for every bundle down to the page's
 * oldest; an older bundle is unknown only when the page is full.
 */
export const firstDownloadOf = (
  patches: NativeBuildDetail["patches"],
  bundleId: string,
): FirstDownload => {
  const patch = patches.data.find((row) => row.bundleId === bundleId);
  if (patch !== undefined) return { kind: "patch", byteSize: patch.byteSize };
  const oldest = patches.data.at(-1)?.bundleId;
  return patches.next !== undefined && oldest !== undefined && bundleId < oldest
    ? { kind: "unknown" }
    : { kind: "full" };
};

function FirstDownloadCell({ download }: { readonly download: FirstDownload }) {
  switch (download.kind) {
    case "patch":
      return (
        <span className="text-xs">
          Patch{" "}
          <span className="text-muted-foreground tabular-nums">
            ({formatByteSize(download.byteSize)})
          </span>
        </span>
      );
    case "full":
      return <span className="text-xs text-muted-foreground">Full bundle</span>;
    case "unknown":
      return (
        <a
          className="text-xs underline-offset-4 hover:underline"
          href="#patches"
        >
          See patches
        </a>
      );
  }
}

/**
 * What the update check offers an install of the build now: its scope's
 * catalog at the build's app version, down to the built-in bundle, newest
 * first. It is the catalog of now, not the history.
 */
export function ServedNowCard({
  detail,
}: {
  readonly detail: NativeBuildDetail;
}) {
  const { servedNow, patches, catalogScopeKey } = detail;
  const scopeLink = (
    <Link
      className="inline-flex items-center gap-0.5 underline-offset-4 hover:underline"
      search={{ scopeKey: catalogScopeKey }}
      to="/"
    >
      All releases in this scope
      <ArrowUpRight aria-hidden="true" className="size-3" />
    </Link>
  );

  return (
    <Card className="overflow-hidden shadow-sm">
      <CardHeader className="border-b px-4 py-3">
        <CardTitle className="text-sm">
          <h2>Served now</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {servedNow.length === 0 ? (
          <Empty className="py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PackageOpen />
              </EmptyMedia>
              <EmptyTitle>No OTA for this build yet</EmptyTitle>
              <EmptyDescription>
                No release in this build's scope is newer than its built-in
                bundle. Deploy one with{" "}
                <code className="font-mono">hot-updater deploy</code>, and it
                shows here.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Link
                className={buttonVariants({
                  className: "min-h-11 sm:min-h-8",
                  variant: "outline",
                })}
                search={{ scopeKey: catalogScopeKey }}
                to="/"
              >
                All releases in this scope
              </Link>
            </EmptyContent>
          </Empty>
        ) : (
          <>
            <Table aria-label="Served now" className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead>Bundle</TableHead>
                  <TableHead className="hidden w-40 md:table-cell">
                    Rollout
                  </TableHead>
                  <TableHead className="hidden w-32 sm:table-cell">
                    Created
                  </TableHead>
                  <TableHead className="w-32">First OTA download</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {servedNow.map((release) => {
                  const bundleId = release.bundleId!;
                  const percentage =
                    (release.rolloutCohortCount / NUMERIC_COHORT_SIZE) * 100;
                  return (
                    <TableRow key={release.releaseId}>
                      <TableCell className="py-3 whitespace-normal">
                        <div className="flex min-w-0 flex-col gap-1">
                          <Link
                            className="font-mono text-xs [overflow-wrap:anywhere] underline-offset-4 hover:underline"
                            search={{ releaseId: release.releaseId }}
                            title={bundleId}
                            to="/"
                            translate="no"
                          >
                            {bundleId}
                          </Link>
                          {release.message ? (
                            <span className="text-xs text-muted-foreground">
                              {release.message}
                            </span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <div className="flex flex-wrap gap-1">
                          {release.targetCohorts.length > 0 ? (
                            <Badge variant="secondary">
                              {release.targetCohorts.length === 1
                                ? "1 cohort"
                                : `${release.targetCohorts.length} cohorts`}
                            </Badge>
                          ) : (
                            <RolloutPercentageBadge percentage={percentage} />
                          )}
                          {release.shouldForceUpdate ? (
                            <Badge variant="outline">Forced</Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <TimestampDisplay uuid={bundleId} />
                      </TableCell>
                      <TableCell>
                        <FirstDownloadCell
                          download={firstDownloadOf(patches, bundleId)}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <p className="border-t px-4 py-3 text-xs text-muted-foreground">
              What the update check serves an install of this build now, newest
              first: not the history. {scopeLink}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
