import hdiffWasmModule from "../assets/hdiff.wasm";
import { bsdiff } from "./bsdiff.js";
import { HdiffError, type HdiffErrorCode } from "./errors.js";
import { hdiff } from "./hdiff.js";
import { installPrecompiledWasm } from "./precompiled.js";

installPrecompiledWasm(hdiffWasmModule);

export { bsdiff, hdiff, HdiffError, type HdiffErrorCode };
