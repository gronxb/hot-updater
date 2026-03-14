/**
 * Manual smoke entry for Deno/Supabase Edge style runtime.
 * Run with: deno run --allow-read tests/runtime/deno.manual.ts
 */
import { hdiff } from "../../dist/deno.js";

const base = new Uint8Array([0]); // replace with real HBC bytes
const next = new Uint8Array([0]); // replace with real HBC bytes

try {
  const patch = await hdiff(base, next);
  console.log("patch bytes:", patch.byteLength);
} catch (error) {
  console.error(error);
}
