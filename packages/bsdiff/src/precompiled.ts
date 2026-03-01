type HdiffGlobal = {
  __HDIFF_PRECOMPILED_WASM__?: unknown;
  __HDIFF_PRECOMPILED_BSDIFF_WASM__?: unknown;
  __HDIFF_PRECOMPILED_HERMES_HBC_WASM__?: unknown;
};

export function installPrecompiledWasm(wasmModule: WebAssembly.Module): void {
  const hdiffGlobal = globalThis as HdiffGlobal;

  if (hdiffGlobal.__HDIFF_PRECOMPILED_WASM__ === undefined) {
    hdiffGlobal.__HDIFF_PRECOMPILED_WASM__ = wasmModule;
  }
  if (hdiffGlobal.__HDIFF_PRECOMPILED_BSDIFF_WASM__ === undefined) {
    hdiffGlobal.__HDIFF_PRECOMPILED_BSDIFF_WASM__ = wasmModule;
  }
  if (hdiffGlobal.__HDIFF_PRECOMPILED_HERMES_HBC_WASM__ === undefined) {
    hdiffGlobal.__HDIFF_PRECOMPILED_HERMES_HBC_WASM__ = wasmModule;
  }
}
