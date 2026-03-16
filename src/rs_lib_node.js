// Node.js entry point for loading the WASM module.
// Deno natively supports `import * as wasm from "./rs_lib.wasm"`,
// but Node.js needs to read and instantiate the WASM file manually.

import "./node_shim.js";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export * from "./lib/rs_lib.internal.js";
import * as internal from "./lib/rs_lib.internal.js";
import { __wbg_set_wasm } from "./lib/rs_lib.internal.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPath = join(__dirname, "lib", "rs_lib.wasm");
const wasmBytes = readFileSync(wasmPath);

const wasmModule = new WebAssembly.Module(wasmBytes);
const wasmInstance = new WebAssembly.Instance(wasmModule, {
  "./rs_lib.internal.js": internal,
  "./snippets/rs_lib-aa8c88480f363a4a/helpers.js": await import(
    "./lib/snippets/rs_lib-aa8c88480f363a4a/helpers.js"
  ),
  "./snippets/sys_traits-4d1fdc43f822dba1/inline0.js": await import(
    "./lib/snippets/sys_traits-4d1fdc43f822dba1/inline0.js"
  ),
});

__wbg_set_wasm(wasmInstance.exports);
wasmInstance.exports.__wbindgen_start();
