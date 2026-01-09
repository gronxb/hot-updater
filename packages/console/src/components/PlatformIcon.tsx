import { Smartphone, Apple } from "lucide-react";

interface PlatformIconProps {
  platform: "ios" | "android";
  className?: string;
}

export function PlatformIcon({ platform, className }: PlatformIconProps) {
  if (platform === "ios") {
    return <Apple className={className} />;
  }
  return <Smartphone className={className} />;
}
