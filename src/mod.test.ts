import {
  MediaType,
  RequestedModuleType,
  ResolutionMode,
  Workspace,
} from "./mod.ts";
import { assert, assertEquals } from "@std/assert";

Deno.test("should resolve and load", async () => {
  const workspace = new Workspace({
    nodeConditions: undefined, // unsure doesn't error
  });
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
    const loadResponse = await loader.load(
      import.meta.url,
      RequestedModuleType.Default,
    );
    if (loadResponse.kind !== "module") {
      throw new Error("Fail");
    }
    assertEquals(typeof loadResponse.specifier, "string");
    assert(loadResponse.code instanceof Uint8Array);
    assertEquals(loadResponse.mediaType, MediaType.TypeScript);
  }
  // node: specifier
  {
    const loadResponse = await loader.load(
      "node:events",
      RequestedModuleType.Default,
    );
    if (loadResponse.kind !== "external") {
      throw new Error("Fail");
    }
    assertEquals(typeof loadResponse.specifier, "string");
    assertEquals(loadResponse.specifier, "node:events");
  }
});
