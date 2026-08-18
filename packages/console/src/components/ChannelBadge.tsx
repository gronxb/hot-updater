import { cn } from "@/lib/utils";

import { Badge } from "./ui/badge";

interface ChannelBadgeProps {
  channel: string;
  className?: string;
}

const channelColors: Record<string, string> = {
  production:
    "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20",
  dev: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20",
  staging:
    "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/20",
};

function getChannelColor(channel: string) {
  const normalizedChannel = channel.toLowerCase();
  const semanticName = normalizedChannel
    .split(/[-_.]/)
    .find((part) => part in channelColors);

  return (
    channelColors[normalizedChannel] ??
    (semanticName ? channelColors[semanticName] : undefined) ??
    "bg-gray-500/10 text-gray-700 dark:text-gray-400 border-gray-500/20"
  );
}

export function ChannelBadge({ channel, className }: ChannelBadgeProps) {
  return (
    <Badge
      variant="outline"
      className={cn(getChannelColor(channel), className)}
    >
      {channel}
    </Badge>
  );
}
