import { HdiffError, type HdiffErrorCode } from "./errors.js";
import { hdiff } from "./hdiff.js";
import { toUint8Array } from "./internal/bytes.js";
import { installPrecompiledWasm } from "./precompiled.js";

const HDIFF_WASM_URL = new URL("../assets/hdiff.wasm", import.meta.url);

installPrecompiledWasm(loadDenoWasmModule());

function loadDenoWasmModule(): WebAssembly.Module {
  const deno = (
    globalThis as {
      Deno?: {
        readFileSync?: (path: string | URL) => Uint8Array<ArrayBufferLike>;
      };
    }
  ).Deno;
  if (!deno || typeof deno.readFileSync !== "function") {
    throw new HdiffError(
      "PATCH_FAILED",
      "Deno runtime does not expose Deno.readFileSync",
    );
  }

  try {
    return new WebAssembly.Module(toUint8Array(deno.readFileSync(HDIFF_WASM_URL)));
  } catch {
    throw new HdiffError(
      "PATCH_FAILED",
      `Failed to load hdiff.wasm for Deno runtime: ${HDIFF_WASM_URL.toString()}`,
    );
  }
}

export { hdiff, HdiffError, type HdiffErrorCode };
