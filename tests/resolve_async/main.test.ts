import { ResolutionMode } from "@deno/loader";
import { createLoader } from "../helpers.ts";
import { assert, assertRejects } from "@std/assert";

Deno.test("resolves npm specifiers and jsr specifiers on demand with resolveAsync", async () => {
  const { loader } = await createLoader({
    configPath: import.meta.dirname + "/testdata/deno.json",
  }, {
    entrypoints: [],
  });

  {
    const jsrUrl = await loader.resolveAsync(
      "jsr:@david/code-block-writer",
      import.meta.url,
      ResolutionMode.Import,
    );
    assert(jsrUrl.startsWith("https://"));
  }
  {
    const npmUrl = await loader.resolveAsync(
      "npm:code-block-writer",
      import.meta.url,
      ResolutionMode.Import,
    );
    assert(npmUrl.startsWith("file:///"));
  }
});

Deno.test("errors when using nodeModulesDir: manual and npm package is not installed", async () => {
  const { loader } = await createLoader({
    configPath: import.meta.dirname + "/testdata/deno.manual_install.json",
  }, {
    entrypoints: [],
  });

  {
    await assertRejects(
      () =>
        loader.resolveAsync(
          "npm:code-block-writer",
          import.meta.url,
          ResolutionMode.Import,
        ),
      Error,
      "Could not find a matching package for 'npm:code-block-writer' in the node_modules directory.",
    );
  }
});
