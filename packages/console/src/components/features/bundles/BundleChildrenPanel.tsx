import type { Bundle } from "@hot-updater/plugin-core";
import { ArrowRight } from "lucide-react";

import { BundleIdDisplay } from "@/components/BundleIdDisplay";
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
}

export function BundleChildrenPanel({
  panelId,
  bundle,
  bundles,
  loading,
  onDetailClick,
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
          <div className="flex min-w-0 items-start gap-2 text-sm sm:items-center">
            <span className="text-muted-foreground">Base artifact ID</span>
            <BundleIdDisplay bundleId={bundle.id} fullOnMobile maxLength={18} />
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
            <div className="text-xs font-semibold uppercase text-muted-foreground/70">
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
                        <div className="text-[11px] font-medium uppercase text-muted-foreground/70">
                          Target artifact ID
                        </div>
                        <BundleIdDisplay
                          bundleId={childBundle.id}
                          fullOnMobile
                          maxLength={18}
                        />
                      </div>
                      <div className="space-y-1">
                        <div className="text-[11px] font-medium uppercase text-muted-foreground/70">
                          Relation
                        </div>
                        <div className="flex flex-col items-start gap-1 text-sm">
                          <BundleIdDisplay
                            bundleId={bundle.id}
                            fullOnMobile
                            maxLength={12}
                          />
                          <ArrowRight className="size-4 rotate-90 text-muted-foreground" />
                          <BundleIdDisplay
                            bundleId={childBundle.id}
                            fullOnMobile
                            maxLength={12}
                          />
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <div className="space-y-1">
                          <div className="text-[11px] font-medium uppercase text-muted-foreground/70">
                            Artifact
                          </div>
                          <Badge variant="secondary">bsdiff</Badge>
                        </div>
                        <div className="space-y-1 text-right">
                          <div className="text-[11px] font-medium uppercase text-muted-foreground/70">
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
                        Detail
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
                      <TableHead className="w-24 text-right">Detail</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {bundles.map((childBundle) => (
                      <TableRow key={childBundle.id}>
                        <TableCell>
                          <BundleIdDisplay
                            bundleId={childBundle.id}
                            fullOnMobile
                            maxLength={18}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex min-w-[280px] flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-2">
                            <BundleIdDisplay
                              bundleId={bundle.id}
                              fullOnMobile
                              maxLength={12}
                            />
                            <ArrowRight className="size-4 shrink-0 rotate-90 text-muted-foreground sm:rotate-0" />
                            <BundleIdDisplay
                              bundleId={childBundle.id}
                              fullOnMobile
                              maxLength={12}
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
                            Detail
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
            <div className="text-xs font-semibold uppercase text-muted-foreground/70">
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
