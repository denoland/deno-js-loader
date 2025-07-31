import { ResolutionMode } from "@deno/loader";
import { createLoader } from "../helpers.ts";
import { assert } from "@std/assert";

Deno.test("resolves to browser locations", async () => {
  const { loader } = await createLoader({
    configPath: import.meta.dirname + "/testdata/deno.json",
    platform: "browser",
  }, {
    entrypoints: [],
  });

  assert(
    loader.resolveSync(
      "package",
      import.meta.resolve("./testdata/main.js"),
      ResolutionMode.Import,
    ).endsWith("browser.js"),
  );
  assert(
    loader.resolveSync(
      "browser-main",
      import.meta.resolve("./testdata/main.js"),
      ResolutionMode.Import,
    ).endsWith("browser.js"),
  );
});
