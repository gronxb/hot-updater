import { cn } from "@/lib/utils";

interface BundleIdDisplayProps {
  bundleId: string;
  maxLength?: number;
  className?: string;
  fullOnMobile?: boolean;
}
export function BundleIdDisplay({ bundleId, className }: BundleIdDisplayProps) {
  return (
    <span
      translate="no"
      className={cn("break-all font-mono text-xs tabular-nums", className)}
    >
      {bundleId}
    </span>
  );
}
