import { assert, assertEquals } from "@std/assert";
import {
  createLoader,
  MediaType,
  type ModuleLoadResponse,
  RequestedModuleType,
  ResolutionMode,
  Workspace,
} from "../helpers.ts";

Deno.test("loader works under Node.js", async () => {
  const result = await new Deno.Command("node", {
    args: [
      "tests/node_compat/testdata/node_test.mjs",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();

  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);

  if (!result.success) {
    throw new Error(
      `Node.js integration test failed (exit code ${result.code}):\n${stdout}\n${stderr}`,
    );
  }
});

Deno.test("workspace noConfig option", async () => {
  const workspace = new Workspace({ noConfig: true });
  const loader = await workspace.createLoader();
  // Should still be able to resolve file specifiers without a config
  const modFileUrl = import.meta.resolve("./testdata/main.ts");
  const resolved = loader.resolveSync(
    modFileUrl,
    undefined,
    ResolutionMode.Import,
  );
  assertEquals(resolved, modFileUrl);
  loader[Symbol.dispose]();
  workspace[Symbol.dispose]();
});

Deno.test("workspace dispose frees resources", async () => {
  const workspace = new Workspace({});
  const loader = await workspace.createLoader();
  // Using Symbol.dispose should not throw
  loader[Symbol.dispose]();
  workspace[Symbol.dispose]();
});

Deno.test("loads TypeScript and checks media type", async () => {
  const mainTs = import.meta.dirname + "/testdata/main.ts";
  const { loader } = await createLoader({
    configPath: import.meta.dirname + "/testdata/deno.json",
  }, {
    entrypoints: [mainTs],
  });

  const mainTsUrl = loader.resolveSync(
    mainTs,
    undefined,
    ResolutionMode.Import,
  );
  const response = await loader.load(mainTsUrl, RequestedModuleType.Default);
  assertEquals(response.kind, "module");
  if (response.kind === "module") {
    assertEquals(response.mediaType, MediaType.TypeScript);
    assert(response.code instanceof Uint8Array);
    const code = new TextDecoder().decode(response.code);
    // Should be transpiled - no type annotations
    assert(!code.includes(": string"), "types should be transpiled away");
    assert(code.includes("node:path"), "import should be preserved");

    // Source map should be available for transpiled TypeScript
    const moduleResponse = response as ModuleLoadResponse;
    assert(
      moduleResponse.sourceMap,
      "sourceMap should be defined for transpiled TS",
    );
    const sm = JSON.parse(new TextDecoder().decode(moduleResponse.sourceMap));
    assertEquals(sm.version, 3);
    assertEquals(sm.sources, ["main.ts"]);
  }
});

Deno.test("noTranspile preserves TypeScript syntax", async () => {
  const mainTs = import.meta.dirname + "/testdata/main.ts";
  const { loader } = await createLoader({
    configPath: import.meta.dirname + "/testdata/deno.json",
    noTranspile: true,
  }, {
    entrypoints: [mainTs],
  });

  const mainTsUrl = loader.resolveSync(
    mainTs,
    undefined,
    ResolutionMode.Import,
  );
  const response = await loader.load(mainTsUrl, RequestedModuleType.Default);
  assertEquals(response.kind, "module");
  if (response.kind === "module") {
    const code = new TextDecoder().decode(response.code);
    assert(
      code.includes(": string"),
      "types should be preserved with noTranspile",
    );
    // Source map should not be present when noTranspile is set
    assertEquals(
      (response as ModuleLoadResponse).sourceMap,
      undefined,
      "sourceMap should be undefined with noTranspile",
    );
  }
});
