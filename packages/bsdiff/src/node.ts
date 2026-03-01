import { readFileSync } from "node:fs";
import { HdiffError, type HdiffErrorCode } from "./errors.js";
import { hdiff } from "./hdiff.js";
import { installPrecompiledWasm } from "./precompiled.js";

const HDIFF_WASM_URL = new URL("../assets/hdiff.wasm", import.meta.url);

installPrecompiledWasm(loadNodeWasmModule());

function loadNodeWasmModule(): WebAssembly.Module {
  try {
    return new WebAssembly.Module(readFileSync(HDIFF_WASM_URL));
  } catch {
    throw new HdiffError(
      "PATCH_FAILED",
      `Failed to load hdiff.wasm for Node runtime: ${HDIFF_WASM_URL.toString()}`,
    );
  }
}

export { hdiff, HdiffError, type HdiffErrorCode };
