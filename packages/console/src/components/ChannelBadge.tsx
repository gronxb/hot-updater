import { Badge } from "./ui/badge";

interface ChannelBadgeProps {
  channel: string;
  className?: string;
}

const channelVariantMap: Record<
  string,
  "success" | "warning" | "info" | "outline"
> = {
  production: "success",
  staging: "warning",
  dev: "info",
};

export function ChannelBadge({ channel, className }: ChannelBadgeProps) {
  const variant = channelVariantMap[channel.toLowerCase()] || "outline";

  return (
    <Badge variant={variant} className={className}>
      {channel}
    </Badge>
  );
}
