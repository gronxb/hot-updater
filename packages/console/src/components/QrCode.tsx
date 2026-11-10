import { useMemo } from "react";

import { qrCodePath } from "@/lib/qr-code";
import { cn } from "@/lib/utils";

/**
 * A QR code of `value`, drawn as one SVG path with the standard four-module
 * quiet zone. Phone cameras read dark modules on a light ground, so the code
 * keeps its own two colors in both themes instead of the theme's tokens.
 */
export function QrCode({
  value,
  label,
  className,
}: {
  readonly value: string;
  /** What scanning opens, for screen readers. */
  readonly label: string;
  readonly className?: string;
}) {
  const { size, path } = useMemo(() => qrCodePath(value), [value]);

  return (
    <svg
      aria-label={label}
      className={cn("aspect-square rounded-md", className)}
      role="img"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${size} ${size}`}
    >
      <rect fill="#fff" height={size} width={size} />
      <path d={path} fill="#000" />
    </svg>
  );
}
