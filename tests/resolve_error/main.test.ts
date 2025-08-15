import { assertEquals, assertThrows } from "@std/assert";
import { createLoader, ResolutionMode } from "../helpers.ts";

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
      )
    );
    assertEquals((err as any).code, "ERR_PACKAGE_PATH_NOT_EXPORTED");
  });

  await t.step("specifier", () => {
    const err = assertThrows(() =>
      loader.resolveSync(
        "open-package/non-existent.js",
        import.meta.resolve("./testdata/main.ts"),
        ResolutionMode.Import,
      )
    );
    assertEquals((err as any).code, "ERR_MODULE_NOT_FOUND");
    assertEquals(
      (err as any).specifier,
      import.meta.resolve(
        "./testdata/node_modules/open-package/non-existent.js",
      ),
    );
  });
});
