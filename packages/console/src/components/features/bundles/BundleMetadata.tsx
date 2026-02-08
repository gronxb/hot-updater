import type { Bundle } from "@hot-updater/plugin-core";
import { ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface BundleMetadataProps {
  bundle: Bundle;
}

export function BundleMetadata({ bundle }: BundleMetadataProps) {
  const hasMetadata =
    bundle.targetAppVersion ||
    bundle.fingerprintHash ||
    bundle.gitCommitHash ||
    bundle.fileHash;

  if (!hasMetadata) return null;

  return (
    <Card variant="subtle">
      <CardHeader className="pb-[var(--spacing-component)]">
        <CardTitle className="text-[length:var(--text-h3)]">
          Bundle Metadata
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-[var(--spacing-component)] text-[length:var(--text-body)]">
        {bundle.targetAppVersion && (
          <div className="flex items-center justify-between py-[var(--spacing-tight)]">
            <span className="text-muted-foreground">App Version</span>
            <span className="font-mono font-medium">{bundle.targetAppVersion}</span>
          </div>
        )}

        {bundle.fingerprintHash && (
          <div className="flex items-center justify-between py-[var(--spacing-tight)]">
            <span className="text-muted-foreground">Fingerprint</span>
            <span className="font-mono text-[length:var(--text-small)]">
              {bundle.fingerprintHash.slice(0, 16)}...
            </span>
          </div>
        )}

        {bundle.gitCommitHash && (
          <div className="flex items-center justify-between py-[var(--spacing-tight)]">
            <span className="text-muted-foreground">Git Commit</span>
            <a
              href={`https://github.com/search?q=${bundle.gitCommitHash}&type=commits`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-[var(--spacing-tight)] text-primary hover:underline font-mono text-[length:var(--text-small)] transition-colors"
            >
              {bundle.gitCommitHash.slice(0, 8)}
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        )}

        {bundle.fileHash && (
          <div className="flex items-center justify-between py-[var(--spacing-tight)]">
            <span className="text-muted-foreground">File Hash</span>
            <span className="font-mono text-[length:var(--text-small)]">
              {bundle.fileHash.slice(0, 16)}...
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
