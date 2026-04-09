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
  baseBundle: Bundle;
  bundles: Bundle[];
  loading: boolean;
  onDetailClick: (bundle: Bundle) => void;
}

function BundleChildrenTable({
  bundles,
  onDetailClick,
}: {
  bundles: Bundle[];
  onDetailClick: (bundle: Bundle) => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-background">
      <Table>
        <TableHeader className="bg-muted/40">
          <TableRow className="hover:bg-transparent">
            <TableHead>Target Bundle</TableHead>
            <TableHead>Patch</TableHead>
            <TableHead>Asset</TableHead>
            <TableHead>Created</TableHead>
            <TableHead className="w-[100px] text-right">Detail</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {bundles.map((bundle) => {
            const isPatchReady =
              bundle.metadata?.hbc_patch_algorithm === "bsdiff" &&
              Boolean(bundle.metadata?.hbc_patch_storage_uri);

            return (
              <TableRow key={bundle.id}>
                <TableCell>
                  <div className="flex min-w-0 items-center gap-2">
                    <BundleIdDisplay bundleId={bundle.id} maxLength={18} />
                    <Badge variant="secondary">Patch</Badge>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={isPatchReady ? "secondary" : "outline"}>
                    {isPatchReady ? "bsdiff" : "Linked"}
                  </Badge>
                </TableCell>
                <TableCell>
                  <span className="block max-w-[260px] truncate font-mono text-xs text-muted-foreground">
                    {bundle.metadata?.hbc_patch_asset_path ?? "—"}
                  </span>
                </TableCell>
                <TableCell className="tabular-nums">
                  <TimestampDisplay uuid={bundle.id} />
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="touch-manipulation"
                    onClick={() => onDetailClick(bundle)}
                  >
                    Detail
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

export function BundleChildrenPanel({
  baseBundle,
  bundles,
  loading,
  onDetailClick,
}: BundleChildrenPanelProps) {
  return (
    <div className="flex flex-col gap-4 bg-muted/15 p-4" aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">Patch Bundles</span>
            <Badge variant="outline">{bundles.length}</Badge>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Base Bundle</span>
            <BundleIdDisplay bundleId={baseBundle.id} maxLength={18} />
          </div>
        </div>
        <p className="max-w-[420px] text-sm text-muted-foreground">
          Direct child bundles that reference this bundle as their diff base.
          Patch artifact details stay in each bundle detail sheet.
        </p>
      </div>

      {loading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : bundles.length > 0 ? (
        <BundleChildrenTable bundles={bundles} onDetailClick={onDetailClick} />
      ) : (
        <div className="rounded-lg border border-dashed border-border/70 bg-background px-4 py-6 text-sm text-muted-foreground">
          No patch bundles currently use this bundle as their diff base.
        </div>
      )}
    </div>
  );
}
