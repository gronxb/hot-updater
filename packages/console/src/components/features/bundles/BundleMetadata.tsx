import {
  getPatchBaseBundleId,
  getPatchBaseFileHash,
  getPatchFileHash,
} from "@hot-updater/core";
import type { Bundle, ReleaseRow } from "@hot-updater/plugin-core";
import { ExternalLink } from "lucide-react";

import { BundleIdDisplay } from "@/components/BundleIdDisplay";
import { HashValueDisplay } from "@/components/HashValueDisplay";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfigQuery } from "@/lib/api";
import { getCommitUrl } from "@/lib/git";

interface BundleMetadataProps {
  readonly bundle: Bundle | null | undefined;
  readonly channelName: string;
  readonly release: ReleaseRow;
}

const createdAtFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-left text-sm sm:text-right">{value}</dd>
    </div>
  );
}

export function BundleMetadata({
  bundle,
  channelName,
  release,
}: BundleMetadataProps) {
  const { data: configData, isFetched } = useConfigQuery();
  const patchBaseBundleId = bundle ? getPatchBaseBundleId(bundle) : null;
  const hbcPatchFileHash = bundle ? getPatchFileHash(bundle) : null;
  const hbcPatchBaseFileHash = bundle ? getPatchBaseFileHash(bundle) : null;
  const gitCommitUrl =
    bundle?.gitCommitHash && isFetched
      ? getCommitUrl(configData?.console.gitUrl, bundle.gitCommitHash)
      : null;
  const target =
    release.strategy === "APP_VERSION"
      ? release.target_app_version
      : release.fingerprint_hash;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Metadata</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="flex flex-col gap-3 text-sm">
          <Row
            label={
              release.strategy === "APP_VERSION"
                ? "Target App Version"
                : "Fingerprint Target"
            }
            value={
              <span className="break-all font-mono text-xs" translate="no">
                {target ?? "—"}
              </span>
            }
          />
          <Row
            label="Channel"
            value={<span translate="no">{channelName}</span>}
          />
          <Row
            label="Platform"
            value={release.platform === "ios" ? "iOS" : "Android"}
          />
          <Row
            label="Created"
            value={createdAtFormatter.format(release.created_at_ms)}
          />
          <Row
            label="Release Revision"
            value={<span className="tabular-nums">{release.revision}</span>}
          />
          {release.bundle_id ? (
            <Row
              label="Bundle ID"
              value={
                <BundleIdDisplay
                  bundleId={release.bundle_id}
                  fullOnMobile
                  maxLength={18}
                />
              }
            />
          ) : null}
          {bundle?.gitCommitHash ? (
            <Row
              label="Git Commit"
              value={
                <div className="flex items-center justify-start gap-1 sm:justify-end">
                  <HashValueDisplay
                    className={gitCommitUrl ? "text-primary" : undefined}
                    maxLength={12}
                    value={bundle.gitCommitHash}
                  />
                  {gitCommitUrl ? (
                    <a
                      aria-label="Open git commit"
                      className="shrink-0 text-primary hover:underline"
                      href={gitCommitUrl}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      <ExternalLink aria-hidden="true" />
                    </a>
                  ) : null}
                </div>
              }
            />
          ) : null}
          {bundle?.fileHash ? (
            <Row
              label="Bundle Hash"
              value={
                <HashValueDisplay maxLength={16} value={bundle.fileHash} />
              }
            />
          ) : null}
          {bundle?.storageUri ? (
            <Row
              label="Storage"
              value={
                <span className="break-all font-mono text-xs" translate="no">
                  {bundle.storageUri}
                </span>
              }
            />
          ) : null}
          {bundle?.manifestStorageUri ? (
            <Row
              label="Manifest"
              value={
                <span className="break-all font-mono text-xs" translate="no">
                  {bundle.manifestStorageUri}
                </span>
              }
            />
          ) : null}
          {bundle?.manifestFileHash ? (
            <Row
              label="Manifest Hash"
              value={
                <HashValueDisplay
                  maxLength={16}
                  value={bundle.manifestFileHash}
                />
              }
            />
          ) : null}
          {bundle?.assetBaseStorageUri ? (
            <Row
              label="Asset Storage"
              value={
                <span className="break-all font-mono text-xs" translate="no">
                  {bundle.assetBaseStorageUri}
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
                  fullOnMobile
                  maxLength={18}
                />
              }
            />
          ) : null}
          {hbcPatchBaseFileHash ? (
            <Row
              label="Base Hash"
              value={
                <HashValueDisplay maxLength={16} value={hbcPatchBaseFileHash} />
              }
            />
          ) : null}
          {hbcPatchFileHash ? (
            <Row
              label="Patch Hash"
              value={
                <HashValueDisplay maxLength={16} value={hbcPatchFileHash} />
              }
            />
          ) : null}
        </dl>
      </CardContent>
    </Card>
  );
}
