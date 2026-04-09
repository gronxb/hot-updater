import type { Bundle } from "@hot-updater/plugin-core";
import { ExternalLink } from "lucide-react";

import { BundleIdDisplay } from "@/components/BundleIdDisplay";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfigQuery } from "@/lib/api";
import { getCommitUrl } from "@/lib/git";

interface BundleMetadataProps {
  bundle: Bundle;
}

export function BundleMetadata({ bundle }: BundleMetadataProps) {
  const { data: configData, isFetched } = useConfigQuery();
  const diffBaseBundleId = bundle.metadata?.diff_base_bundle_id;
  const hbcPatchAssetPath = bundle.metadata?.hbc_patch_asset_path;
  const hbcPatchFileHash = bundle.metadata?.hbc_patch_file_hash;
  const hasMetadata =
    bundle.targetAppVersion ||
    bundle.fingerprintHash ||
    bundle.gitCommitHash ||
    bundle.fileHash ||
    diffBaseBundleId ||
    hbcPatchAssetPath ||
    hbcPatchFileHash;
  const gitCommitUrl =
    bundle.gitCommitHash && isFetched
      ? getCommitUrl(configData?.console.gitUrl, bundle.gitCommitHash)
      : null;

  if (!hasMetadata) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Metadata</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {bundle.targetAppVersion && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">App Version</span>
            <span className="font-mono">{bundle.targetAppVersion}</span>
          </div>
        )}

        {bundle.fingerprintHash && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Fingerprint</span>
            <span className="font-mono text-xs">
              {bundle.fingerprintHash.slice(0, 16)}...
            </span>
          </div>
        )}

        {bundle.gitCommitHash && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Git Commit</span>
            {gitCommitUrl ? (
              <a
                href={gitCommitUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-primary hover:underline font-mono text-xs"
              >
                {bundle.gitCommitHash.slice(0, 8)}
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : (
              <span className="font-mono text-xs">
                {bundle.gitCommitHash.slice(0, 8)}
              </span>
            )}
          </div>
        )}

        {bundle.fileHash && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">File Hash</span>
            <span className="font-mono text-xs">
              {bundle.fileHash.slice(0, 16)}...
            </span>
          </div>
        )}

        {diffBaseBundleId && (
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">Diff Base</span>
            <BundleIdDisplay bundleId={diffBaseBundleId} maxLength={18} />
          </div>
        )}

        {hbcPatchAssetPath && (
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">Patch Asset</span>
            <span className="font-mono text-xs">{hbcPatchAssetPath}</span>
          </div>
        )}

        {hbcPatchFileHash && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Patch Hash</span>
            <span className="font-mono text-xs">
              {hbcPatchFileHash.slice(0, 16)}...
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
