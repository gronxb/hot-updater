import { cn } from "@/lib/utils";

interface BundleIdDisplayProps {
  bundleId: string;
  maxLength?: number;
  className?: string;
  fullOnMobile?: boolean;
}

function shortenBundleId(bundleId: string, maxLength: number): string {
  if (bundleId.length <= maxLength) {
    return bundleId;
  }

  if (maxLength <= 6) {
    return bundleId.slice(0, maxLength);
  }

  const edgeLength = Math.floor((maxLength - 3) / 2);
  const headLength = maxLength - 3 - edgeLength;
  return `${bundleId.slice(0, headLength)}...${bundleId.slice(-edgeLength)}`;
}

export function BundleIdDisplay({
  bundleId,
  className,
  fullOnMobile = false,
  maxLength,
}: BundleIdDisplayProps) {
  const displayBundleId = maxLength
    ? shortenBundleId(bundleId, maxLength)
    : bundleId;
  const shouldShorten = displayBundleId !== bundleId;

  return (
    <span
      translate="no"
      title={shouldShorten ? bundleId : undefined}
      className={cn("break-all font-mono text-xs tabular-nums", className)}
    >
      {shouldShorten && fullOnMobile ? (
        <>
          <span className="sm:hidden">{bundleId}</span>
          <span className="hidden sm:inline">{displayBundleId}</span>
        </>
      ) : (
        displayBundleId
      )}
    </span>
  );
}
