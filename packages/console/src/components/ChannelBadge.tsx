import { cn } from "@/lib/utils";

import { Badge } from "./ui/badge";

interface ChannelBadgeProps {
  channel: string;
  className?: string;
}

/** The channels with their own color; any other channel is neutral. */
const COLORED_CHANNELS = new Set(["production", "staging", "dev"]);

export function ChannelBadge({ channel, className }: ChannelBadgeProps) {
  const name = channel.toLowerCase();
  return (
    <Badge
      variant="outline"
      data-channel={COLORED_CHANNELS.has(name) ? name : undefined}
      className={cn(
        "border-channel-other/20 bg-channel-other/10 text-channel-other",
        "data-[channel=production]:border-channel-production/20 data-[channel=production]:bg-channel-production/10 data-[channel=production]:text-channel-production",
        "data-[channel=staging]:border-channel-staging/20 data-[channel=staging]:bg-channel-staging/10 data-[channel=staging]:text-channel-staging",
        "data-[channel=dev]:border-channel-dev/20 data-[channel=dev]:bg-channel-dev/10 data-[channel=dev]:text-channel-dev",
        className,
      )}
    >
      {channel}
    </Badge>
  );
}
