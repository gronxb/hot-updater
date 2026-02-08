import { Badge } from "./ui/badge";

interface ChannelBadgeProps {
  channel: string;
  className?: string;
}

const CHANNEL_VARIANTS = [
  "success",
  "info",
  "warning",
  "secondary",
  "outline",
] as const;

type ChannelVariant = (typeof CHANNEL_VARIANTS)[number];

function hashToVariant(str: string): ChannelVariant {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return CHANNEL_VARIANTS[Math.abs(hash) % CHANNEL_VARIANTS.length];
}

export function ChannelBadge({ channel, className }: ChannelBadgeProps) {
  const variant = hashToVariant(channel.toLowerCase());

  return (
    <Badge variant={variant} className={className}>
      {channel}
    </Badge>
  );
}
