/**
 * Manual smoke entry for Bun runtime.
 * Run with: bun tests/runtime/bun.manual.ts
 */
import { hdiff } from "../../dist/bun.js";

const base = new Uint8Array([0]); // replace with real HBC bytes
const next = new Uint8Array([0]); // replace with real HBC bytes

try {
  const patch = await hdiff(base, next);
  console.log("patch bytes:", patch.byteLength);
} catch (error) {
  console.error(error);
}
