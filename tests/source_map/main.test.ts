import { assert, assertEquals } from "@std/assert";
import {
  createLoader,
  type ModuleLoadResponse,
  RequestedModuleType,
  ResolutionMode,
} from "../helpers.ts";

const configPath = import.meta.dirname + "/testdata/deno.json";

function resolveAndLoad(
  loader: { resolveSync: Function; load: Function },
  file: string,
  moduleType = RequestedModuleType.Default,
) {
  const url = loader.resolveSync(file, undefined, ResolutionMode.Import);
  return loader.load(url, moduleType) as Promise<ModuleLoadResponse>;
}

// deno-lint-ignore no-explicit-any
function parseSourceMap(response: ModuleLoadResponse): any {
  assert(
    response.sourceMap instanceof Uint8Array,
    "sourceMap should be a Uint8Array",
  );
  return JSON.parse(new TextDecoder().decode(response.sourceMap));
}

Deno.test("source map returned for transpiled TypeScript", async () => {
  const { loader } = await createLoader({ configPath }, {
    entrypoints: [import.meta.dirname + "/testdata/simple.ts"],
  });

  const response = await resolveAndLoad(
    loader,
    import.meta.dirname + "/testdata/simple.ts",
  );

  assertEquals(response.kind, "module");
  const sm = parseSourceMap(response);
  assertEquals(sm.version, 3);
  assertEquals(sm.sources, ["simple.ts"]);
  assertEquals(typeof sm.mappings, "string", "mappings should be present");
});

Deno.test("source map contains sourcesContent with original source", async () => {
  const { loader } = await createLoader({ configPath }, {
    entrypoints: [import.meta.dirname + "/testdata/simple.ts"],
  });

  const response = await resolveAndLoad(
    loader,
    import.meta.dirname + "/testdata/simple.ts",
  );

  const sm = parseSourceMap(response);
  assert(Array.isArray(sm.sourcesContent), "sourcesContent should be present");
  assertEquals(sm.sourcesContent.length, 1);
  assert(
    sm.sourcesContent[0].includes(": string"),
    "original source should contain type annotations",
  );
});

Deno.test("source map not returned for plain JavaScript", async () => {
  const { loader } = await createLoader({ configPath }, {
    entrypoints: [import.meta.dirname + "/testdata/plain.js"],
  });

  const response = await resolveAndLoad(
    loader,
    import.meta.dirname + "/testdata/plain.js",
  );

  assertEquals(response.kind, "module");
  assertEquals(response.sourceMap, undefined);
});

Deno.test("source map not returned for JSON", async () => {
  const simpleTs = import.meta.dirname + "/testdata/simple.ts";
  const { loader } = await createLoader({ configPath }, {
    entrypoints: [simpleTs],
  });

  const dataUrl = loader.resolveSync(
    import.meta.dirname + "/testdata/data.json",
    undefined,
    ResolutionMode.Import,
  );
  const response = await loader.load(
    dataUrl,
    RequestedModuleType.Json,
  ) as ModuleLoadResponse;

  assertEquals(response.kind, "module");
  assertEquals(response.sourceMap, undefined);
});

Deno.test("source map not returned when noTranspile is set", async () => {
  const { loader } = await createLoader(
    { configPath, noTranspile: true },
    { entrypoints: [import.meta.dirname + "/testdata/simple.ts"] },
  );

  const response = await resolveAndLoad(
    loader,
    import.meta.dirname + "/testdata/simple.ts",
  );

  assertEquals(response.kind, "module");
  assertEquals(response.sourceMap, undefined);
  const code = new TextDecoder().decode(response.code);
  assert(code.includes(": string"), "types should be preserved");
});

Deno.test("source map for complex TypeScript with interfaces and classes", async () => {
  const { loader } = await createLoader({ configPath }, {
    entrypoints: [import.meta.dirname + "/testdata/interfaces.ts"],
  });

  const response = await resolveAndLoad(
    loader,
    import.meta.dirname + "/testdata/interfaces.ts",
  );

  assertEquals(response.kind, "module");
  const sm = parseSourceMap(response);
  assertEquals(sm.version, 3);
  assertEquals(sm.sources, ["interfaces.ts"]);
  assert(sm.sourcesContent[0].includes("interface User"));
  assert(sm.sourcesContent[0].includes("class UserService"));

  // transpiled code should not have type annotations
  const code = new TextDecoder().decode(response.code);
  assert(!code.includes("interface User"), "interfaces should be removed");
  assert(!code.includes(": string"), "type annotations should be removed");
  assert(code.includes("class UserService"), "class should remain");
});

Deno.test("source map is valid JSON", async () => {
  const { loader } = await createLoader({ configPath }, {
    entrypoints: [import.meta.dirname + "/testdata/interfaces.ts"],
  });

  const response = await resolveAndLoad(
    loader,
    import.meta.dirname + "/testdata/interfaces.ts",
  );

  const sm = parseSourceMap(response);
  // Validate required source map fields per spec
  assertEquals(typeof sm.version, "number");
  assert(Array.isArray(sm.sources));
  assertEquals(typeof sm.mappings, "string");
  // Optional but expected fields
  assert(Array.isArray(sm.names));
});

Deno.test("inline source map comment remains in code", async () => {
  const { loader } = await createLoader({ configPath }, {
    entrypoints: [import.meta.dirname + "/testdata/simple.ts"],
  });

  const response = await resolveAndLoad(
    loader,
    import.meta.dirname + "/testdata/simple.ts",
  );

  const code = new TextDecoder().decode(response.code);
  assert(
    code.includes("//# sourceMappingURL=data:application/json;base64,"),
    "inline source map comment should remain in code",
  );
});

Deno.test("source map for external node: specifier is not applicable", async () => {
  const { loader } = await createLoader({ configPath }, {
    entrypoints: [import.meta.dirname + "/testdata/simple.ts"],
  });

  const response = await loader.load("node:path", RequestedModuleType.Default);
  assertEquals(response.kind, "external");
});
