import type { Bundle } from "@hot-updater/plugin-core";
import { ArrowRight } from "lucide-react";

import { ArtifactIdDisplay } from "@/components/ArtifactIdDisplay";
import { ReleaseIdDisplay } from "@/components/ReleaseIdDisplay";
import { TimestampDisplay } from "@/components/TimestampDisplay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useIsMobile } from "@/hooks/use-mobile";

interface BundleChildrenPanelProps {
  panelId: string;
  bundle: Bundle;
  bundles: Bundle[];
  loading: boolean;
  onDetailClick: (bundle: Bundle) => void;
  /**
   * The labeled release that serves an artifact in the expanded Bundle's
   * channel and platform, or null when none is known: the artifact then
   * shows its ID alone.
   */
  releaseOf?: (artifactId: string) => ServingRelease | null;
}

/** A release an artifact is served by: its label names it, with its own ID. */
export interface ServingRelease {
  readonly id: string;
  readonly label: number;
}

/**
 * An artifact's ID, then the release serving it. A label's tail is its
 * release ID, never the artifact's, so `vN` reads the same as on its row.
 */
function ArtifactId({
  id,
  release,
}: {
  readonly id: string;
  readonly release: ServingRelease | null;
}) {
  return (
    <span className="flex min-w-0 flex-col items-start gap-1">
      <ArtifactIdDisplay artifactId={id} />
      {release ? (
        <span className="inline-flex items-baseline gap-1.5 text-xs text-muted-foreground">
          Release
          <ReleaseIdDisplay releaseId={release.id} label={release.label} />
        </span>
      ) : null}
    </span>
  );
}

/** One side of a patch: the release serving the artifact, else its ID. */
function ArtifactName({
  id,
  release,
}: {
  readonly id: string;
  readonly release: ServingRelease | null;
}) {
  return release ? (
    <ReleaseIdDisplay releaseId={release.id} label={release.label} />
  ) : (
    <ArtifactIdDisplay artifactId={id} />
  );
}

export function BundleChildrenPanel({
  panelId,
  bundle,
  bundles,
  loading,
  onDetailClick,
  releaseOf = () => null,
}: BundleChildrenPanelProps) {
  const isMobile = useIsMobile();

  return (
    <div
      aria-live="polite"
      className="border-t bg-muted/10 p-3 sm:p-4"
      id={panelId}
    >
      <div className="flex flex-col gap-4">
        <h3 className="text-sm font-medium">Advanced artifact diagnostics</h3>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2 text-sm">
            <span className="shrink-0 text-muted-foreground">
              Base artifact ID
            </span>
            <ArtifactId id={bundle.id} release={releaseOf(bundle.id)} />
          </div>
          <Badge variant="outline">
            {bundles.length} {bundles.length === 1 ? "patch" : "patches"}
          </Badge>
        </div>

        {loading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : bundles.length > 0 ? (
          <div className="flex flex-col gap-2">
            <div className="text-xs font-medium text-muted-foreground">
              Patch artifacts from this base
            </div>
            {isMobile ? (
              <div className="flex flex-col gap-2">
                {bundles.map((childBundle) => (
                  <div
                    className="rounded-md border bg-background p-3"
                    key={childBundle.id}
                  >
                    <div className="flex flex-col gap-3">
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-muted-foreground">
                          Target artifact ID
                        </div>
                        <ArtifactId
                          id={childBundle.id}
                          release={releaseOf(childBundle.id)}
                        />
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-muted-foreground">
                          Relation
                        </div>
                        <div className="flex flex-col items-start gap-1 text-sm">
                          <ArtifactName
                            id={bundle.id}
                            release={releaseOf(bundle.id)}
                          />
                          <ArrowRight className="size-4 rotate-90 text-muted-foreground" />
                          <ArtifactName
                            id={childBundle.id}
                            release={releaseOf(childBundle.id)}
                          />
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <div className="space-y-1">
                          <div className="text-xs font-medium text-muted-foreground">
                            Artifact
                          </div>
                          <Badge variant="secondary">bsdiff</Badge>
                        </div>
                        <div className="space-y-1 text-right">
                          <div className="text-xs font-medium text-muted-foreground">
                            Created
                          </div>
                          <div className="text-xs tabular-nums text-foreground">
                            <TimestampDisplay uuid={childBundle.id} />
                          </div>
                        </div>
                      </div>
                      <Button
                        className="w-full"
                        onClick={() => onDetailClick(childBundle)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        Open bundle
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="overflow-x-auto rounded-md border bg-background">
                <Table className="min-w-max">
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Target artifact ID</TableHead>
                      <TableHead>Relation</TableHead>
                      <TableHead>Artifact</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead className="w-24 text-right">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {bundles.map((childBundle) => (
                      <TableRow key={childBundle.id}>
                        <TableCell>
                          <ArtifactId
                            id={childBundle.id}
                            release={releaseOf(childBundle.id)}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex min-w-[280px] flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-2">
                            <ArtifactName
                              id={bundle.id}
                              release={releaseOf(bundle.id)}
                            />
                            <ArrowRight className="size-4 shrink-0 rotate-90 text-muted-foreground sm:rotate-0" />
                            <ArtifactName
                              id={childBundle.id}
                              release={releaseOf(childBundle.id)}
                            />
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary">bsdiff</Badge>
                        </TableCell>
                        <TableCell className="tabular-nums">
                          <TimestampDisplay uuid={childBundle.id} />
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            onClick={() => onDetailClick(childBundle)}
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            Open bundle
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="text-xs font-medium text-muted-foreground">
              Patch artifacts from this base
            </div>
            <div className="rounded-md border bg-background p-3 text-sm text-muted-foreground">
              No direct patch artifacts.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
