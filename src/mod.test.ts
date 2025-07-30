import {
  MediaType,
  RequestedModuleType,
  ResolutionMode,
  Workspace,
} from "./mod.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";

Deno.test("should resolve, load and get graph", async () => {
  const workspace = new Workspace({
    nodeConditions: undefined, // ensure doesn't error
  });
  const modFileUrl = import.meta.resolve("./mod.ts");
  const { loader, diagnostics } = await workspace.createLoader({
    entrypoints: [modFileUrl],
  });
  assertEquals(diagnostics.length, 0);
  const graph = loader.getGraphUnstable();
  assertEquals((graph as any).roots[0], modFileUrl);
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

Deno.test("resolving a jsr specifier should fail with explanatory message", async () => {
  const workspace = new Workspace({});
  const modFileUrl = import.meta.resolve("./mod.ts");
  const { loader, diagnostics } = await workspace.createLoader({
    entrypoints: [modFileUrl],
  });
  assertEquals(diagnostics.length, 0);
  assertRejects(
    async () => {
      await loader.load(
        "jsr:@scope/version",
        RequestedModuleType.Default,
      );
    },
    Error,
    "Failed loading 'jsr:@scope/version'. jsr: specifiers must be resolved to an https: specifier before being loaded.",
  );
});
