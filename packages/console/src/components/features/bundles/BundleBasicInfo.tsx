import { getPatchBaseBundleId, getPatchStorageUri } from "@hot-updater/core";
import type { Bundle } from "@hot-updater/plugin-core";

import { BundleIdDisplay } from "@/components/BundleIdDisplay";
import { PlatformIcon } from "@/components/PlatformIcon";
import { Badge } from "@/components/ui/badge";

interface BundleBasicInfoProps {
  bundle: Bundle;
}

export function BundleBasicInfo({ bundle }: BundleBasicInfoProps) {
  const patchBaseBundleId = getPatchBaseBundleId(bundle);
  const patchReady = Boolean(patchBaseBundleId && getPatchStorageUri(bundle));

  return (
    <div className="mt-1 flex flex-col gap-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2">
          <PlatformIcon platform={bundle.platform} className="h-4 w-4" />
          <span className="font-medium">
            {bundle.platform === "ios" ? "iOS" : "Android"}
          </span>
        </div>
        <Badge variant={patchBaseBundleId ? "secondary" : "outline"}>
          {patchBaseBundleId ? "Derived" : "Root"}
        </Badge>
        {patchReady ? <Badge variant="secondary">BSDIFF Ready</Badge> : null}
      </div>

      <div className="flex items-center gap-2">
        <span className="font-medium text-muted-foreground">Bundle</span>
        <BundleIdDisplay bundleId={bundle.id} maxLength={18} />
      </div>

      <div className="flex items-center gap-2">
        <span className="font-medium text-muted-foreground">Channel</span>
        <span className="text-xs text-foreground" translate="no">
          {bundle.channel}
        </span>
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
