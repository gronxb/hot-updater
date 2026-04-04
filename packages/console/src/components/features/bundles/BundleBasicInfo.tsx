import type { Bundle } from "@hot-updater/plugin-core";

import { PlatformIcon } from "@/components/PlatformIcon";

interface BundleBasicInfoProps {
  bundle: Bundle;
}

export function BundleBasicInfo({ bundle }: BundleBasicInfoProps) {
  return (
    <div className="flex flex-col gap-3 text-sm mt-1">
      <div className="flex items-center gap-2">
        <PlatformIcon platform={bundle.platform} className="h-4 w-4" />
        <span className="font-medium">
          {bundle.platform === "ios" ? "iOS" : "Android"}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="font-medium text-muted-foreground">Bundle ID</span>
        <span className="text-xs text-foreground">{bundle.id}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="font-medium text-muted-foreground">Channel</span>
        <span className="text-xs text-foreground">{bundle.channel}</span>
      </div>
    </div>
  );
}
