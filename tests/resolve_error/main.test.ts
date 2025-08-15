import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createLoader, ResolutionMode, ResolveError } from "../helpers.ts";

Deno.test("error has extra properties", async (t) => {
  const mainFile = import.meta.dirname + "/testdata/main.ts";
  const { loader } = await createLoader({
    configPath: import.meta.dirname + "/testdata/deno.json",
  }, {
    entrypoints: [mainFile],
  });

  await t.step("code", () => {
    const err = assertThrows(() =>
      loader.resolveSync(
        "export-package/non-existent",
        import.meta.resolve("./testdata/main.ts"),
        ResolutionMode.Import,
      ), ResolveError);
    assertEquals(err.code, "ERR_PACKAGE_PATH_NOT_EXPORTED");
  });

  await t.step("specifier", async () => {
    const err = await assertRejects(
      () =>
        loader.resolve(
          "open-package/non-existent.js",
          import.meta.resolve("./testdata/main.ts"),
          ResolutionMode.Import,
        ),
      ResolveError,
    );
    assertEquals(err.code, "ERR_MODULE_NOT_FOUND");
    assertEquals(
      err.specifier,
      import.meta.resolve(
        "./testdata/node_modules/open-package/non-existent.js",
      ),
    );
  });
});
