import { DenoWorkspace, MediaType, ResolutionMode } from "./mod.ts";
import { assert, assertEquals } from "@std/assert";

Deno.test("should resolve and load", async () => {
  const workspace = new DenoWorkspace();
  const modFileUrl = import.meta.resolve("./mod.ts");
  const loader = await workspace.createLoader({
    entrypoints: [modFileUrl],
  });
  const resolvedUrl = loader.resolve(
    "./mod.test.ts",
    modFileUrl,
    ResolutionMode.Import,
  );
  assertEquals(resolvedUrl, import.meta.url);
  {
    const loadResponse = await loader.load(import.meta.url);
    if (loadResponse.kind !== "module")
      throw new Error("Fail");
    assertEquals(typeof loadResponse.specifier, "string");
    assert(loadResponse.code instanceof Uint8Array);
    assertEquals(loadResponse.mediaType, MediaType.TypeScript);
  }
  // node: specifier
  {
    const loadResponse = await loader.load("node:events");
    if (loadResponse.kind !== "external")
      throw new Error("Fail");
    assertEquals(typeof loadResponse.specifier, "string");
    assertEquals(loadResponse.specifier, "node:events");
  }
});
