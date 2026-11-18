import type { Bundle, ReleaseRow } from "@hot-updater/plugin-core";
import { getPatchBaseFileHash, getPatchFileHash } from "@hot-updater/protocol";
import { ExternalLink } from "lucide-react";
import { useId, useState } from "react";

import { HashValueDisplay } from "@/components/HashValueDisplay";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useConfigQuery } from "@/lib/api";
import { CONSOLE_GIT_URL_GUIDE_URL } from "@/lib/constants";
import { getCommitUrl } from "@/lib/git";

interface BundleMetadataProps {
  readonly bundle: Bundle | null | undefined;
  readonly release: ReleaseRow;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-left text-sm sm:text-right">{value}</dd>
    </div>
  );
}

function GitUrlHint() {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen} triggerId={id}>
      <TooltipTrigger
        id={id}
        aria-describedby={open ? `${id}-description` : undefined}
        closeOnClick={false}
        onClick={() => setOpen(true)}
        render={
          <button
            type="button"
            className="relative ml-1 shrink-0 cursor-help text-xs text-muted-foreground underline decoration-dotted underline-offset-4 outline-none after:absolute after:-inset-2.5 hover:text-foreground focus-visible:text-foreground focus-visible:ring-[2px] focus-visible:ring-ring/30 rounded-sm md:after:hidden"
          />
        }
      >
        Not linked
      </TooltipTrigger>
      <TooltipContent
        id={`${id}-description`}
        className="max-w-64"
        side="bottom"
      >
        <p>
          Set <code className="font-mono">console.gitUrl</code> in your config
          to open commits in your repository.{" "}
          <a
            className="font-medium underline underline-offset-2"
            href={CONSOLE_GIT_URL_GUIDE_URL}
            rel="noopener noreferrer"
            target="_blank"
          >
            Learn more
          </a>
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

export function BundleMetadata({ bundle, release }: BundleMetadataProps) {
  const { data: configData, isFetched } = useConfigQuery();
  const hbcPatchFileHash = bundle ? getPatchFileHash(bundle) : null;
  const hbcPatchBaseFileHash = bundle ? getPatchBaseFileHash(bundle) : null;
  const gitCommitUrl =
    bundle?.gitCommitHash && isFetched
      ? getCommitUrl(configData?.console.gitUrl, bundle.gitCommitHash)
      : null;
  const showGitUrlHint =
    isFetched &&
    Boolean(bundle?.gitCommitHash) &&
    !configData?.console.gitUrl?.trim();
  const target =
    release.strategy === "APP_VERSION"
      ? release.target_app_version
      : release.fingerprint_hash;
  const hasMetadata =
    target ||
    bundle?.gitCommitHash ||
    bundle?.manifestFileHash ||
    hbcPatchBaseFileHash ||
    hbcPatchFileHash;

  if (!hasMetadata) return null;

  return (
    <Card>
      <CardHeader className="p-4 pb-3">
        <CardTitle className="text-sm font-medium">Metadata</CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <dl className="flex flex-col gap-3 text-sm">
          <Row
            label={
              release.strategy === "APP_VERSION"
                ? "Target app version"
                : "Fingerprint target"
            }
            value={
              <span className="break-all font-mono text-xs" translate="no">
                {target ?? "—"}
              </span>
            }
          />
          {bundle?.gitCommitHash ? (
            <Row
              label="Git commit"
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
                  {showGitUrlHint ? <GitUrlHint /> : null}
                </div>
              }
            />
          ) : null}
          {bundle?.manifestFileHash ? (
            <Row
              label="Manifest hash"
              value={
                <HashValueDisplay
                  maxLength={16}
                  value={bundle.manifestFileHash}
                />
              }
            />
          ) : null}
          {hbcPatchBaseFileHash ? (
            <Row
              label="Base hash"
              value={
                <HashValueDisplay maxLength={16} value={hbcPatchBaseFileHash} />
              }
            />
          ) : null}
          {hbcPatchFileHash ? (
            <Row
              label="Patch hash"
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
