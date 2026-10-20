import { useMemo } from "react";
import { encode } from "uqr";

import { cn } from "@/lib/utils";

/**
 * A QR code of `value`, drawn as one SVG path. Phone cameras read dark
 * modules on a light ground, so the code keeps its own two colors in both
 * themes instead of the theme's tokens.
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
  const { size, path } = useMemo(() => {
    const { data, size } = encode(value, { ecc: "M", border: 2 });
    let path = "";
    data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) path += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return { size, path };
  }, [value]);

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
