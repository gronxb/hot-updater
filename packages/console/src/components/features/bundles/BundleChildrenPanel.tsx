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
  return (
    <div id={panelId} className="border-t bg-muted/10 p-4" aria-live="polite">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <span className="text-muted-foreground">Base bundle</span>
            <BundleIdDisplay bundleId={bundle.id} maxLength={18} />
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
              Patch bundles from this base
            </div>
            <div className="overflow-hidden rounded-md border bg-background">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Patch Bundle</TableHead>
                    <TableHead>Relation</TableHead>
                    <TableHead>Artifact</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="w-[96px] text-right">
                      Detail
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bundles.map((childBundle) => (
                    <TableRow key={childBundle.id}>
                      <TableCell>
                        <BundleIdDisplay
                          bundleId={childBundle.id}
                          maxLength={18}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex min-w-[280px] items-center gap-2">
                          <BundleIdDisplay
                            bundleId={bundle.id}
                            maxLength={12}
                          />
                          <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <BundleIdDisplay
                            bundleId={childBundle.id}
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
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => onDetailClick(childBundle)}
                        >
                          Detail
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="text-xs font-semibold uppercase text-muted-foreground/70">
              Patch bundles from this base
            </div>
            <div className="rounded-md border bg-background p-3 text-sm text-muted-foreground">
              No direct patch bundles.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
