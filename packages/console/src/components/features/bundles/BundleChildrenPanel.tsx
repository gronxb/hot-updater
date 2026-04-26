import { getBundlePatches } from "@hot-updater/core";
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

const isPatchReady = (bundle: Bundle) => getBundlePatches(bundle).length > 0;

const getPatchCountLabel = (bundle: Bundle) => {
  const patchCount = getBundlePatches(bundle).length;
  return `${patchCount} ${patchCount === 1 ? "patch" : "patches"}`;
};

const truncateHash = (hash: string) =>
  hash.length > 12 ? `${hash.slice(0, 12)}...` : hash;

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
  const patchArtifacts = getBundlePatches(bundle);
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
            label="Created from"
            value={
              <Badge variant={patchReady ? "secondary" : "outline"}>
                {patchReady ? getPatchCountLabel(bundle) : "full bundle"}
              </Badge>
            }
          />
          <SummaryItem
            label="Used as base"
            value={
              <span translate="no" className="text-sm tabular-nums">
                {bundles.length}
              </span>
            }
          />
        </div>

        <div className="flex flex-col gap-2">
          <div className="text-xs font-semibold uppercase text-muted-foreground/70">
            Patch base bundles
          </div>
          {patchArtifacts.length > 0 ? (
            <div className="overflow-hidden rounded-md border bg-background">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Base Bundle</TableHead>
                    <TableHead>Relation</TableHead>
                    <TableHead>Base Hash</TableHead>
                    <TableHead>Patch Hash</TableHead>
                    <TableHead>Artifact</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {patchArtifacts.map((patch) => (
                    <TableRow key={patch.baseBundleId}>
                      <TableCell>
                        <BundleIdDisplay
                          bundleId={patch.baseBundleId}
                          maxLength={18}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex min-w-[280px] items-center gap-2">
                          <BundleIdDisplay
                            bundleId={patch.baseBundleId}
                            maxLength={12}
                          />
                          <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <BundleIdDisplay
                            bundleId={bundle.id}
                            maxLength={12}
                          />
                        </div>
                      </TableCell>
                      <TableCell>
                        <span translate="no" className="font-mono text-xs">
                          {truncateHash(patch.baseFileHash)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span translate="no" className="font-mono text-xs">
                          {truncateHash(patch.patchFileHash)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">bsdiff</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="rounded-md border bg-background p-3 text-sm text-muted-foreground">
              This bundle was uploaded as a full bundle.
            </div>
          )}
        </div>

        {loading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : bundles.length > 0 ? (
          <div className="flex flex-col gap-2">
            <div className="text-xs font-semibold uppercase text-muted-foreground/70">
              Bundles using this as base
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
              Bundles using this as base
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
