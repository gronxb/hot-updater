import { createHash } from "node:crypto";

// Model stable application data in main so a main patch plus raw detail costs
// less than the complete archive. Generate it at build time, never at runtime.
export const matrixStableMain = () =>
  process.env.HOT_UPDATER_MATRIX_STABLE_MAIN === "1"
    ? Buffer.concat(
        Array.from({ length: 8192 }, (_, index) =>
          createHash("sha256").update(`lynx-matrix-main:${index}`).digest(),
        ),
      ).toString("base64")
    : "";
