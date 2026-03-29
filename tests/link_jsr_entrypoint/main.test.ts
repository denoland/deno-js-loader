import { assert, assertEquals } from "@std/assert";
import {
  assertResponseText,
  createLoader,
  type ModuleLoadResponse,
  RequestedModuleType,
  ResolutionMode,
} from "../helpers.ts";

Deno.test("loads linked entrypoint", async () => {
  const mainFile = import.meta.dirname + "/testdata/main/main.ts";
  const { loader } = await createLoader({
    configPath: import.meta.resolve("./testdata/main/deno.json"),
  }, {
    entrypoints: [mainFile],
  });

  const response = await loader.load(
    loader.resolveSync("@denotest/add", undefined, ResolutionMode.Import),
    RequestedModuleType.Default,
  );
  assertResponseText(
    response,
    `export function add(a, b) {
  return a + b;
}
`,
    { skipSourceMap: true },
  );

  // Linked TypeScript package should have a source map
  const moduleResponse = response as ModuleLoadResponse;
  assert(
    moduleResponse.sourceMap,
    "sourceMap should be defined for linked TS package",
  );
  const sm = JSON.parse(new TextDecoder().decode(moduleResponse.sourceMap));
  assertEquals(sm.version, 3);
  assert(Array.isArray(sm.sources));
});
