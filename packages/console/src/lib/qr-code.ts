import { encode } from "uqr";

/**
 * A QR code of `value` as one SVG path of unit squares, with the standard
 * four-module quiet zone: `size` is the side of its viewBox.
 */
export const qrCodePath = (value: string): { size: number; path: string } => {
  const { data, size } = encode(value, { ecc: "M", border: 4 });
  let path = "";
  data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x} ${y}h1v1h-1z`;
    }),
  );
  return { size, path };
};
