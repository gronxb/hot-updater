import type { Bundle } from "@hot-updater/plugin-core";

import { BundleIdDisplay } from "@/components/BundleIdDisplay";
import { ChannelBadge } from "@/components/ChannelBadge";
import { PlatformIcon } from "@/components/PlatformIcon";
import { Badge } from "@/components/ui/badge";

interface BundleBasicInfoProps {
  bundle: Bundle;
}

export function BundleBasicInfo({ bundle }: BundleBasicInfoProps) {
  const patchReady =
    bundle.metadata?.hbc_patch_algorithm === "bsdiff" &&
    Boolean(bundle.metadata?.hbc_patch_storage_uri);

  return (
    <div className="mt-1 flex flex-col gap-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-background/80 px-2.5 py-1.5">
          <PlatformIcon platform={bundle.platform} className="h-4 w-4" />
          <span className="font-medium">
            {bundle.platform === "ios" ? "iOS" : "Android"}
          </span>
        </div>
        <ChannelBadge channel={bundle.channel} />
        <Badge
          variant={
            bundle.metadata?.diff_base_bundle_id ? "secondary" : "outline"
          }
        >
          {bundle.metadata?.diff_base_bundle_id ? "Derived" : "Root"}
        </Badge>
        {patchReady ? <Badge variant="secondary">BSDIFF Ready</Badge> : null}
      </div>

      <div className="flex items-center gap-2">
        <span className="font-medium text-muted-foreground">Bundle</span>
        <BundleIdDisplay bundleId={bundle.id} maxLength={18} />
      </div>

      <div className="flex items-center gap-2">
        <span className="font-medium text-muted-foreground">Channel</span>
        <span className="text-xs text-foreground">{bundle.channel}</span>
      </div>

      <div className="flex items-center gap-2">
        <span className="font-medium text-muted-foreground">Platform</span>
        <span className="text-xs text-foreground">
          {bundle.platform === "ios" ? "iOS" : "Android"}
        </span>
      </div>
    </div>
  );
}
