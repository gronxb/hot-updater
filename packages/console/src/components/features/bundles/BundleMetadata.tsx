import type { Bundle } from "@hot-updater/plugin-core";
import { ExternalLink } from "lucide-react";

import { BundleIdDisplay } from "@/components/BundleIdDisplay";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfigQuery } from "@/lib/api";
import { getCommitUrl } from "@/lib/git";

interface BundleMetadataProps {
  bundle: Bundle;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <div className="min-w-0 text-right text-sm">{value}</div>
    </div>
  );
}

const truncateValue = (value: string, maxLength = 16) =>
  value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;

export function BundleMetadata({ bundle }: BundleMetadataProps) {
  const { data: configData, isFetched } = useConfigQuery();
  const diffBaseBundleId = bundle.metadata?.diff_base_bundle_id;
  const hbcPatchAssetPath = bundle.metadata?.hbc_patch_asset_path;
  const hbcPatchFileHash = bundle.metadata?.hbc_patch_file_hash;
  const hbcPatchBaseFileHash = bundle.metadata?.hbc_patch_base_file_hash;
  const hbcPatchAlgorithm = bundle.metadata?.hbc_patch_algorithm;
  const hasMetadata =
    bundle.targetAppVersion ||
    bundle.fingerprintHash ||
    bundle.gitCommitHash ||
    bundle.fileHash ||
    diffBaseBundleId ||
    hbcPatchAssetPath ||
    hbcPatchBaseFileHash ||
    hbcPatchFileHash ||
    hbcPatchAlgorithm;
  const gitCommitUrl =
    bundle.gitCommitHash && isFetched
      ? getCommitUrl(configData?.console.gitUrl, bundle.gitCommitHash)
      : null;

  if (!hasMetadata) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Metadata</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {bundle.targetAppVersion ? (
          <Row
            label="App Version"
            value={
              <span translate="no" className="font-mono">
                {bundle.targetAppVersion}
              </span>
            }
          />
        ) : null}

        {bundle.fingerprintHash ? (
          <Row
            label="Fingerprint"
            value={
              <span translate="no" className="font-mono text-xs">
                {truncateValue(bundle.fingerprintHash)}
              </span>
            }
          />
        ) : null}

        {bundle.gitCommitHash ? (
          <Row
            label="Git Commit"
            value={
              gitCommitUrl ? (
                <a
                  href={gitCommitUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-end gap-1 font-mono text-xs text-primary hover:underline"
                >
                  <span translate="no">{bundle.gitCommitHash.slice(0, 8)}</span>
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
          <Row
            label="Bundle Hash"
            value={
              <span translate="no" className="font-mono text-xs">
                {truncateValue(bundle.fileHash)}
              </span>
            }
          />
        ) : null}

        {diffBaseBundleId ? (
          <Row
            label="Diff Base"
            value={
              <BundleIdDisplay bundleId={diffBaseBundleId} maxLength={18} />
            }
          />
        ) : null}

        {hbcPatchAlgorithm ? (
          <Row
            label="Patch Algorithm"
            value={
              <span translate="no" className="font-mono text-xs">
                {hbcPatchAlgorithm}
              </span>
            }
          />
        ) : null}

        {hbcPatchAssetPath ? (
          <Row
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
          <Row
            label="Base Hash"
            value={
              <span translate="no" className="font-mono text-xs">
                {truncateValue(hbcPatchBaseFileHash)}
              </span>
            }
          />
        ) : null}

        {hbcPatchFileHash ? (
          <Row
            label="Patch Hash"
            value={
              <span translate="no" className="font-mono text-xs">
                {truncateValue(hbcPatchFileHash)}
              </span>
            }
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
