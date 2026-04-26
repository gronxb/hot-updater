import {
  getPatchBaseBundleId,
  getPatchBaseFileHash,
  getPatchFileHash,
} from "@hot-updater/core";
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
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <span className="text-muted-foreground">{label}</span>
      <div className="min-w-0 text-left text-sm sm:text-right">{value}</div>
    </div>
  );
}

const truncateValue = (value: string, maxLength = 16) =>
  value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;

export function BundleMetadata({ bundle }: BundleMetadataProps) {
  const { data: configData, isFetched } = useConfigQuery();
  const patchBaseBundleId = getPatchBaseBundleId(bundle);
  const hbcPatchFileHash = getPatchFileHash(bundle);
  const hbcPatchBaseFileHash = getPatchBaseFileHash(bundle);
  const hasMetadata =
    bundle.targetAppVersion ||
    bundle.fingerprintHash ||
    bundle.gitCommitHash ||
    bundle.fileHash ||
    patchBaseBundleId ||
    hbcPatchBaseFileHash ||
    hbcPatchFileHash;
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
                  className="flex items-center justify-start gap-1 font-mono text-xs text-primary hover:underline sm:justify-end"
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

        {patchBaseBundleId ? (
          <Row
            label="Patch Base"
            value={
              <BundleIdDisplay
                bundleId={patchBaseBundleId}
                maxLength={18}
                fullOnMobile
              />
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
