import { assertEquals } from "@std/assert";
import { createLoaderWithDiagnostics } from "../helpers.ts";

Deno.test("surfaces graph diagnostic", async () => {
  const mainFile = import.meta.dirname + "/testdata/main.ts";
  const { diagnostics } = await createLoaderWithDiagnostics({
    configPath: import.meta.dirname + "/testdata/deno.json",
  }, {
    entrypoints: [mainFile],
  });

  assertEquals(diagnostics.length, 1);
  const expectedMessage =
    'Relative import path "unknown" not prefixed with / or ./ or ../';
  assertEquals(
    diagnostics[0].message.substring(0, expectedMessage.length),
    expectedMessage,
  );
});
