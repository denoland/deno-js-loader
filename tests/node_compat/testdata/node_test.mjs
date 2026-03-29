// Node.js integration test for @deno/loader.
// Imports via the public mod.ts API to verify the full Node.js path:
// runtime detection → dynamic import → WASM instantiation → loader operations.

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  Workspace,
  Loader,
  ResolutionMode,
  RequestedModuleType,
  MediaType,
  ResolveError,
} from "../../../src/mod.ts";

const configPath = fileURLToPath(new URL("deno.json", import.meta.url));
const mainTsPath = fileURLToPath(new URL("main.ts", import.meta.url));
const mainTsUrl = new URL("main.ts", import.meta.url).href;

let passed = 0;

function test(name, fn) {
  return fn().then(
    () => {
      passed++;
      console.log(`  ok - ${name}`);
    },
    (err) => {
      console.error(`  FAIL - ${name}`);
      console.error(err);
      process.exit(1);
    },
  );
}

console.log("Node.js integration tests");

// ---------- workspace & loader creation ----------

await test("create workspace and loader", async () => {
  const workspace = new Workspace({ configPath });
  const loader = await workspace.createLoader();
  assert.ok(loader instanceof Loader);
  loader[Symbol.dispose]();
  workspace[Symbol.dispose]();
});

// ---------- entrypoints, resolve, load ----------

const workspace = new Workspace({ configPath });
const loader = await workspace.createLoader();

await test("add entrypoints", async () => {
  const diagnostics = await loader.addEntrypoints([mainTsPath]);
  assert.deepStrictEqual(diagnostics, []);
});

await test("resolveSync resolves a file specifier", async () => {
  const resolved = loader.resolveSync(
    mainTsPath,
    undefined,
    ResolutionMode.Import,
  );
  assert.ok(resolved.endsWith("main.ts"), `unexpected: ${resolved}`);
});

await test("resolveSync resolves relative specifier", async () => {
  const resolved = loader.resolveSync(
    "./main.ts",
    mainTsUrl,
    ResolutionMode.Import,
  );
  assert.ok(resolved.endsWith("main.ts"), `unexpected: ${resolved}`);
});

await test("resolve (async) resolves a specifier", async () => {
  const resolved = await loader.resolve(
    "./main.ts",
    mainTsUrl,
    ResolutionMode.Import,
  );
  assert.ok(resolved.endsWith("main.ts"), `unexpected: ${resolved}`);
});

await test("load returns transpiled TypeScript", async () => {
  const response = await loader.load(mainTsUrl, RequestedModuleType.Default);
  assert.strictEqual(response.kind, "module");
  assert.ok(response.code instanceof Uint8Array);
  assert.strictEqual(response.mediaType, MediaType.TypeScript);
  const code = new TextDecoder().decode(response.code);
  assert.ok(!code.includes(": string"), "types should be transpiled away");
  assert.ok(code.includes("node:path"), "import should be preserved");
});

await test("load returns source map for transpiled TypeScript", async () => {
  const response = await loader.load(mainTsUrl, RequestedModuleType.Default);
  assert.strictEqual(response.kind, "module");
  assert.ok(response.sourceMap instanceof Uint8Array, "sourceMap should be Uint8Array");
  const sm = JSON.parse(new TextDecoder().decode(response.sourceMap));
  assert.strictEqual(sm.version, 3);
  assert.ok(Array.isArray(sm.sources), "sources should be an array");
  assert.ok(sm.sources[0].includes("main.ts"), "source should reference main.ts");
});

await test("load node: specifier returns external", async () => {
  const response = await loader.load(
    "node:path",
    RequestedModuleType.Default,
  );
  assert.strictEqual(response.kind, "external");
  assert.strictEqual(response.specifier, "node:path");
});

// ---------- graph ----------

await test("get_graph returns graph with roots", async () => {
  const graph = loader.getGraphUnstable();
  assert.ok(graph != null);
  assert.ok(Array.isArray(graph.roots));
  assert.ok(graph.roots.length > 0);
});

// ---------- error handling ----------

await test("loading non-existent module throws", async () => {
  const nonExistentUrl = new URL("does_not_exist.ts", import.meta.url).href;
  await assert.rejects(
    () => loader.load(nonExistentUrl, RequestedModuleType.Default),
    (err) => {
      assert.ok(err instanceof Error);
      return true;
    },
  );
});

// ---------- cleanup ----------

loader[Symbol.dispose]();
workspace[Symbol.dispose]();

console.log(`\n${passed} tests passed`);
