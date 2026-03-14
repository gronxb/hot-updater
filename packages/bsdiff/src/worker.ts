import hdiffWasmModule from "../assets/hdiff.wasm";
import { HdiffError, type HdiffErrorCode } from "./errors.js";
import { hdiff } from "./hdiff.js";
import { installPrecompiledWasm } from "./precompiled.js";

installPrecompiledWasm(hdiffWasmModule);

export { hdiff, HdiffError, type HdiffErrorCode };
