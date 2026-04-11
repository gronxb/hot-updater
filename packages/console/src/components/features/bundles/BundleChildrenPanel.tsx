import type { Bundle } from "@hot-updater/plugin-core";
import {
  ArrowRight,
  Binary,
  Boxes,
  FileCode2,
  GitBranchPlus,
  Link2,
  Sparkles,
} from "lucide-react";
import type { ReactNode } from "react";

import { BundleIdDisplay } from "@/components/BundleIdDisplay";
import { TimestampDisplay } from "@/components/TimestampDisplay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { useBundleQuery } from "@/lib/api";

interface BundleChildrenPanelProps {
  panelId: string;
  bundle: Bundle;
  bundles: Bundle[];
  loading: boolean;
  onDetailClick: (bundle: Bundle) => void;
}

const isPatchReady = (bundle: Bundle) =>
  bundle.metadata?.hbc_patch_algorithm === "bsdiff" &&
  Boolean(bundle.metadata?.hbc_patch_storage_uri);

const truncateHash = (value: string) =>
  value.length > 16 ? `${value.slice(0, 16)}…` : value;

function LineageNode({
  label,
  value,
  meta,
}: {
  label: string;
  value: ReactNode;
  meta: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-2xl border border-border/70 bg-background/90 p-4 shadow-sm">
      <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </span>
      <div className="min-w-0">{value}</div>
      <span className="text-xs text-muted-foreground">{meta}</span>
    </div>
  );
}

function MetadataRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-4">
      <span className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </span>
      <div className="min-w-0 text-right text-sm">{value}</div>
    </div>
  );
}

function DerivedBundleItem({
  bundle,
  onDetailClick,
}: {
  bundle: Bundle;
  onDetailClick: (bundle: Bundle) => void;
}) {
  const patchReady = isPatchReady(bundle);
  const label =
    bundle.message?.trim() ||
    bundle.targetAppVersion ||
    bundle.metadata?.hbc_patch_asset_path ||
    "No release note";

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-background/90 p-4 shadow-sm transition-colors hover:bg-accent/20 md:flex-row md:items-center md:justify-between">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <BundleIdDisplay bundleId={bundle.id} maxLength={18} />
          <Badge variant="secondary">Patch</Badge>
          <Badge variant={patchReady ? "secondary" : "outline"}>
            {patchReady ? "BSDIFF Ready" : "Base Linked"}
          </Badge>
        </div>

        <div className="flex min-w-0 flex-col gap-2 text-xs text-muted-foreground md:flex-row md:items-center md:gap-4">
          <span className="min-w-0 truncate">{label}</span>
          <span className="min-w-0 truncate font-mono" translate="no">
            {bundle.metadata?.hbc_patch_asset_path ?? "No patch asset path"}
          </span>
          <span className="tabular-nums">
            <TimestampDisplay uuid={bundle.id} />
          </span>
        </div>
      </div>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="touch-manipulation"
        onClick={() => onDetailClick(bundle)}
      >
        Detail
      </Button>
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
  const baseBundleId = bundle.metadata?.diff_base_bundle_id ?? "";
  const patchReady = isPatchReady(bundle);
  const { data: diffBaseBundle, isPending: isDiffBasePending } =
    useBundleQuery(baseBundleId);

  return (
    <div
      id={panelId}
      className="border-t border-border/70 bg-linear-to-r from-primary/6 via-background to-background/95"
      aria-live="polite"
    >
      <div className="flex flex-col gap-4 p-4 md:p-5">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <Card className="border-border/70 bg-background/90 shadow-sm">
            <CardHeader className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={baseBundleId ? "secondary" : "outline"}>
                  {baseBundleId ? "Derived Bundle" : "Root Bundle"}
                </Badge>
                {patchReady ? (
                  <Badge variant="secondary">Hermes BSDIFF Ready</Badge>
                ) : null}
                <Badge variant="outline">
                  {bundles.length} Direct Children
                </Badge>
              </div>
              <div className="flex flex-col gap-1">
                <CardDescription>Patch Lineage</CardDescription>
                <CardTitle className="text-balance text-base">
                  Read the relationship before opening the detail sheet
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)] lg:items-center">
                <LineageNode
                  label="Base Bundle"
                  value={
                    baseBundleId ? (
                      isDiffBasePending ? (
                        <Skeleton className="h-5 w-28" />
                      ) : (
                        <BundleIdDisplay
                          bundleId={diffBaseBundle?.id ?? baseBundleId}
                          maxLength={18}
                        />
                      )
                    ) : (
                      <span className="text-sm font-medium">No Base</span>
                    )
                  }
                  meta={
                    baseBundleId
                      ? "Clients must report this bundle before a patch can apply."
                      : "This bundle stands on its own and can seed future patches."
                  }
                />
                <ArrowRight
                  aria-hidden="true"
                  className="hidden text-muted-foreground lg:block"
                />
                <LineageNode
                  label="Current Bundle"
                  value={
                    <BundleIdDisplay bundleId={bundle.id} maxLength={18} />
                  }
                  meta="This is the bundle row you expanded from the main table."
                />
                <ArrowRight
                  aria-hidden="true"
                  className="hidden text-muted-foreground lg:block"
                />
                <LineageNode
                  label="Derived Bundles"
                  value={
                    <span translate="no" className="text-lg font-semibold">
                      {bundles.length}
                    </span>
                  }
                  meta="Direct children that point at the current bundle as their diff base."
                />
              </div>

              <div className="rounded-2xl border border-border/70 bg-muted/25 p-4 text-sm text-muted-foreground">
                {baseBundleId ? (
                  <>
                    When the app reports{" "}
                    <span translate="no" className="font-mono text-foreground">
                      {baseBundleId.slice(0, 8)}
                    </span>
                    , the server can return a BSDIFF patch for this bundle
                    instead of the full Hermes asset.
                  </>
                ) : (
                  <>
                    This bundle has no upstream patch dependency. Expand it to
                    inspect any direct patch targets built on top of it.
                  </>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/70 bg-background/90 shadow-sm">
            <CardHeader className="flex flex-col gap-1">
              <CardDescription>Patch Artifact</CardDescription>
              <CardTitle className="text-balance text-base">
                Hermes BSDIFF payload
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {patchReady || baseBundleId ? (
                <>
                  <MetadataRow
                    label="Algorithm"
                    value={
                      <div className="flex justify-end">
                        <Badge variant={patchReady ? "secondary" : "outline"}>
                          {bundle.metadata?.hbc_patch_algorithm ?? "Not Ready"}
                        </Badge>
                      </div>
                    }
                  />
                  <MetadataRow
                    label="Patch Asset"
                    value={
                      <span
                        translate="no"
                        className="block break-all font-mono text-xs text-muted-foreground"
                      >
                        {bundle.metadata?.hbc_patch_asset_path ??
                          "No patch asset path"}
                      </span>
                    }
                  />
                  <MetadataRow
                    label="Base Hash"
                    value={
                      bundle.metadata?.hbc_patch_base_file_hash ? (
                        <span
                          translate="no"
                          className="font-mono text-xs text-muted-foreground"
                        >
                          {truncateHash(
                            bundle.metadata.hbc_patch_base_file_hash,
                          )}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          Not Attached
                        </span>
                      )
                    }
                  />
                  <MetadataRow
                    label="Patch Hash"
                    value={
                      bundle.metadata?.hbc_patch_file_hash ? (
                        <span
                          translate="no"
                          className="font-mono text-xs text-muted-foreground"
                        >
                          {truncateHash(bundle.metadata.hbc_patch_file_hash)}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          Not Attached
                        </span>
                      )
                    }
                  />
                </>
              ) : (
                <Empty className="border-border/60 bg-muted/20">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Binary aria-hidden="true" />
                    </EmptyMedia>
                    <EmptyTitle>No Patch Artifact</EmptyTitle>
                    <EmptyDescription>
                      Pick a base bundle from the detail sheet to generate and
                      attach a Hermes BSDIFF payload.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="border-border/70 bg-background/90 shadow-sm">
          <CardHeader className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
            <div className="flex flex-col gap-1">
              <CardDescription>Derived Bundles</CardDescription>
              <CardTitle className="text-balance text-base">
                Direct children built from this bundle
              </CardTitle>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="gap-1">
                <Boxes aria-hidden="true" className="h-3.5 w-3.5" />
                {bundles.length} Child Bundles
              </Badge>
              {patchReady ? (
                <Badge variant="secondary" className="gap-1">
                  <Sparkles aria-hidden="true" className="h-3.5 w-3.5" />
                  Patch Target Ready
                </Badge>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {loading ? (
              <>
                <Skeleton className="h-24 w-full rounded-2xl" />
                <Skeleton className="h-24 w-full rounded-2xl" />
              </>
            ) : bundles.length > 0 ? (
              bundles.map((childBundle) => (
                <DerivedBundleItem
                  key={childBundle.id}
                  bundle={childBundle}
                  onDetailClick={onDetailClick}
                />
              ))
            ) : (
              <Empty className="border-border/60 bg-muted/20">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <GitBranchPlus aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>No Direct Patch Bundles</EmptyTitle>
                  <EmptyDescription>
                    No bundle currently points at{" "}
                    <span translate="no" className="font-mono">
                      {bundle.id.slice(0, 8)}
                    </span>{" "}
                    as its diff base.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>

        {baseBundleId ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Link2 aria-hidden="true" className="h-3.5 w-3.5" />
            <span>
              Lineage view is flat on purpose. Bundles stay first-class rows,
              and patching is expressed as metadata on the target bundle.
            </span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <FileCode2 aria-hidden="true" className="h-3.5 w-3.5" />
            <span>
              This view shows direct relationships only. Recursive tree UX needs
              a dedicated patch relation model, not just metadata edges.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
