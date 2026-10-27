import { Fragment } from "react";

import { PlatformIcon } from "@/components/PlatformIcon";
import type { HealthPlatform } from "@/lib/release-adoption";

export const platformLabel = (platform: HealthPlatform) =>
  platform === "all" ? "All platforms" : platform === "ios" ? "iOS" : "Android";

/** What a report reads, as the filters set it: its channel, platform, and any narrower filter. */
export function InsightsScope({
  channel,
  platform,
  narrower = [],
}: {
  readonly channel: string;
  readonly platform: HealthPlatform;
  readonly narrower?: readonly string[];
}) {
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
      <span className="max-w-full truncate font-medium text-foreground">
        {channel}
      </span>
      <span aria-hidden="true">·</span>
      <span className="inline-flex items-center gap-1">
        {platform === "all" ? null : (
          <PlatformIcon platform={platform} className="size-3" />
        )}
        {platformLabel(platform)}
      </span>
      {narrower.map((filter) => (
        <Fragment key={filter}>
          <span aria-hidden="true">·</span>
          <span className="max-w-full truncate">{filter}</span>
        </Fragment>
      ))}
    </p>
  );
}
