// Node.js integration test for @deno/loader.
// Exercises the WASM loader under Node.js to verify the Deno API shim works.

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { DenoWorkspace, DenoLoader } from "../../../src/rs_lib_node.js";

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
  const workspace = new DenoWorkspace({ configPath });
  const loader = await workspace.create_loader();
  assert.ok(loader instanceof DenoLoader);
  loader.free();
  workspace.free();
});

// ---------- entrypoints, resolve, load ----------

const workspace = new DenoWorkspace({ configPath });
const loader = await workspace.create_loader();

await test("add entrypoints", async () => {
  const diagnostics = await loader.add_entrypoints([mainTsPath]);
  assert.deepStrictEqual(diagnostics, []);
});

await test("resolve_sync resolves a file specifier", async () => {
  const resolved = loader.resolve_sync(mainTsPath, undefined, 0 /* Import */);
  assert.ok(resolved.endsWith("main.ts"), `unexpected: ${resolved}`);
});

await test("resolve_sync resolves relative specifier", async () => {
  const resolved = loader.resolve_sync("./main.ts", mainTsUrl, 0);
  assert.ok(resolved.endsWith("main.ts"), `unexpected: ${resolved}`);
});

await test("resolve (async) resolves a specifier", async () => {
  const resolved = await loader.resolve("./main.ts", mainTsUrl, 0);
  assert.ok(resolved.endsWith("main.ts"), `unexpected: ${resolved}`);
});

await test("load returns transpiled TypeScript", async () => {
  const response = await loader.load(mainTsUrl, 0 /* Default */);
  assert.strictEqual(response.kind, "module");
  assert.ok(response.code instanceof Uint8Array);
  const code = new TextDecoder().decode(response.code);
  // TypeScript types should be stripped
  assert.ok(!code.includes(": string"), "types should be transpiled away");
  // The import should remain
  assert.ok(code.includes("node:path"), "import should be preserved");
});

await test("load node: specifier returns external", async () => {
  const response = await loader.load("node:path", 0);
  assert.strictEqual(response.kind, "external");
  assert.strictEqual(response.specifier, "node:path");
});

// ---------- graph ----------

await test("get_graph returns graph with roots", async () => {
  const graph = loader.get_graph();
  assert.ok(graph != null);
  assert.ok(Array.isArray(graph.roots));
  assert.ok(graph.roots.length > 0);
});

// ---------- error handling ----------

await test("loading non-existent module throws", async () => {
  const nonExistentUrl = new URL("does_not_exist.ts", import.meta.url).href;
  await assert.rejects(
    () => loader.load(nonExistentUrl, 0),
    (err) => {
      assert.ok(err instanceof Error);
      return true;
    },
  );
});

// ---------- cleanup ----------

loader.free();
workspace.free();

console.log(`\n${passed} tests passed`);
