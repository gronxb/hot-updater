import type { Bundle } from "@hot-updater/plugin-core";
import { Binary, ExternalLink, FileCode2, GitBranchPlus } from "lucide-react";
import type { ReactNode } from "react";

import { BundleIdDisplay } from "@/components/BundleIdDisplay";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { useConfigQuery } from "@/lib/api";
import { getCommitUrl } from "@/lib/git";

interface BundleMetadataProps {
  bundle: Bundle;
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

const truncateValue = (value: string, maxLength = 16) =>
  value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;

export function BundleMetadata({ bundle }: BundleMetadataProps) {
  const { data: configData, isFetched } = useConfigQuery();
  const diffBaseBundleId = bundle.metadata?.diff_base_bundle_id;
  const hbcPatchAssetPath = bundle.metadata?.hbc_patch_asset_path;
  const hbcPatchFileHash = bundle.metadata?.hbc_patch_file_hash;
  const hbcPatchBaseFileHash = bundle.metadata?.hbc_patch_base_file_hash;
  const hbcPatchAlgorithm = bundle.metadata?.hbc_patch_algorithm;
  const hasGeneralMetadata =
    bundle.targetAppVersion ||
    bundle.fingerprintHash ||
    bundle.gitCommitHash ||
    bundle.fileHash;
  const hasPatchMetadata =
    diffBaseBundleId ||
    hbcPatchAssetPath ||
    hbcPatchFileHash ||
    hbcPatchBaseFileHash ||
    hbcPatchAlgorithm;
  const gitCommitUrl =
    bundle.gitCommitHash && isFetched
      ? getCommitUrl(configData?.console.gitUrl, bundle.gitCommitHash)
      : null;

  if (!hasGeneralMetadata && !hasPatchMetadata) {
    return null;
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="flex flex-col gap-1">
          <CardDescription>Bundle Metadata</CardDescription>
          <CardTitle className="text-base">Delivery & Source</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {hasGeneralMetadata ? (
            <>
              {bundle.targetAppVersion ? (
                <MetadataRow
                  label="App Version"
                  value={
                    <span translate="no" className="font-mono">
                      {bundle.targetAppVersion}
                    </span>
                  }
                />
              ) : null}

              {bundle.fingerprintHash ? (
                <MetadataRow
                  label="Fingerprint"
                  value={
                    <span translate="no" className="font-mono text-xs">
                      {truncateValue(bundle.fingerprintHash)}
                    </span>
                  }
                />
              ) : null}

              {bundle.gitCommitHash ? (
                <MetadataRow
                  label="Git Commit"
                  value={
                    gitCommitUrl ? (
                      <a
                        href={gitCommitUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center justify-end gap-1 font-mono text-xs text-primary hover:underline"
                      >
                        <span translate="no">
                          {bundle.gitCommitHash.slice(0, 8)}
                        </span>
                        <ExternalLink aria-hidden="true" className="h-3 w-3" />
                      </a>
                    ) : (
                      <span translate="no" className="font-mono text-xs">
                        {bundle.gitCommitHash.slice(0, 8)}
                      </span>
                    )
                  }
                />
              ) : null}

              {bundle.fileHash ? (
                <MetadataRow
                  label="Bundle Hash"
                  value={
                    <span translate="no" className="font-mono text-xs">
                      {truncateValue(bundle.fileHash)}
                    </span>
                  }
                />
              ) : null}
            </>
          ) : (
            <Empty className="border-border/60 bg-muted/20">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FileCode2 aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>No Bundle Metadata</EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-1">
          <CardDescription>Patch Metadata</CardDescription>
          <CardTitle className="text-base">BSDIFF Relationship</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {hasPatchMetadata ? (
            <>
              {diffBaseBundleId ? (
                <MetadataRow
                  label="Diff Base"
                  value={
                    <BundleIdDisplay
                      bundleId={diffBaseBundleId}
                      maxLength={18}
                    />
                  }
                />
              ) : null}

              {hbcPatchAlgorithm ? (
                <MetadataRow
                  label="Algorithm"
                  value={
                    <span translate="no" className="font-mono text-xs">
                      {hbcPatchAlgorithm}
                    </span>
                  }
                />
              ) : null}

              {hbcPatchAssetPath ? (
                <MetadataRow
                  label="Patch Asset"
                  value={
                    <span
                      translate="no"
                      className="block break-all font-mono text-xs text-muted-foreground"
                    >
                      {hbcPatchAssetPath}
                    </span>
                  }
                />
              ) : null}

              {hbcPatchBaseFileHash ? (
                <MetadataRow
                  label="Base Hash"
                  value={
                    <span translate="no" className="font-mono text-xs">
                      {truncateValue(hbcPatchBaseFileHash)}
                    </span>
                  }
                />
              ) : null}

              {hbcPatchFileHash ? (
                <MetadataRow
                  label="Patch Hash"
                  value={
                    <span translate="no" className="font-mono text-xs">
                      {truncateValue(hbcPatchFileHash)}
                    </span>
                  }
                />
              ) : null}
            </>
          ) : (
            <Empty className="border-border/60 bg-muted/20">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Binary aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>No BSDIFF Metadata</EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}

          {diffBaseBundleId ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <GitBranchPlus aria-hidden="true" className="h-3.5 w-3.5" />
              <span>
                This bundle stays a first-class row. The patch relationship is
                attached as metadata on the target bundle.
              </span>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
