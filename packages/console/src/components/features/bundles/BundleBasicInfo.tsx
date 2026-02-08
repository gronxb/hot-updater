import type { Bundle } from "@hot-updater/plugin-core";
import { PlatformIcon } from "@/components/PlatformIcon";

interface BundleBasicInfoProps {
  bundle: Bundle;
}

export function BundleBasicInfo({ bundle }: BundleBasicInfoProps) {
  return (
    <div className="flex items-center gap-[var(--spacing-component)] text-[length:var(--text-body)]">
      <div className="flex items-center gap-[var(--spacing-element)]">
        <PlatformIcon platform={bundle.platform} className="h-4 w-4" />
        <span className="font-medium">
          {bundle.platform === "ios" ? "iOS" : "Android"}
        </span>
      </div>
      <span className="text-muted-foreground">•</span>
      <span className="font-mono text-[length:var(--text-small)]">{bundle.id}</span>
    </div>
  );
}
