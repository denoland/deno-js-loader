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
  const loadResponse = await loader.load(import.meta.url);
  assertEquals(typeof loadResponse.specifier, "string");
  assert(loadResponse.code instanceof Uint8Array);
  assertEquals(loadResponse.mediaType, MediaType.TypeScript);
});
