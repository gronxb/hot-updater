import { getPatchBaseBundleId, getPatchStorageUri } from "@hot-updater/core";
import type { Bundle } from "@hot-updater/plugin-core";

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

const isPatchReady = (bundle: Bundle) =>
  Boolean(getPatchBaseBundleId(bundle) && getPatchStorageUri(bundle));

function SummaryItem({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <div className="min-w-0">{value}</div>
    </div>
  );
}

export function BundleChildrenPanel({
  panelId,
  bundle,
  bundles,
  loading,
  onDetailClick,
}: BundleChildrenPanelProps) {
  const baseBundleId = getPatchBaseBundleId(bundle);
  const patchReady = isPatchReady(bundle);

  return (
    <div id={panelId} className="border-t bg-muted/10 p-4" aria-live="polite">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <SummaryItem
            label="Bundle"
            value={<BundleIdDisplay bundleId={bundle.id} maxLength={18} />}
          />
          <SummaryItem
            label="Base"
            value={
              baseBundleId ? (
                <BundleIdDisplay bundleId={baseBundleId} maxLength={18} />
              ) : (
                <Badge variant="outline">Root</Badge>
              )
            }
          />
          <SummaryItem
            label="Patch"
            value={
              <Badge variant={patchReady ? "secondary" : "outline"}>
                {patchReady ? "bsdiff" : "none"}
              </Badge>
            }
          />
          <SummaryItem
            label="Children"
            value={
              <span translate="no" className="text-sm tabular-nums">
                {bundles.length}
              </span>
            }
          />
        </div>

        {loading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : bundles.length > 0 ? (
          <div className="overflow-hidden rounded-md border bg-background">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Bundle</TableHead>
                  <TableHead>Patch</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-[96px] text-right">Detail</TableHead>
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
                      <Badge
                        variant={
                          isPatchReady(childBundle) ? "secondary" : "outline"
                        }
                      >
                        {isPatchReady(childBundle) ? "bsdiff" : "linked"}
                      </Badge>
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
        ) : (
          <div className="text-sm text-muted-foreground">
            No direct child bundles.
          </div>
        )}
      </div>
    </div>
  );
}
