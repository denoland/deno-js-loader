import {
  assertResponseText,
  createLoader,
  ResolutionMode,
} from "../helpers.ts";

Deno.test("loads linked entrypoint", async () => {
  const mainFile = import.meta.dirname + "/testdata/main/main.ts";
  const { loader } = await createLoader({
    configPath: import.meta.dirname + "/testdata/main/deno.json",
  }, {
    entrypoints: [mainFile, "jsr:@denotest/add", "@denotest/add"],
  });

  const response = await loader.load(
    loader.resolve("@denotest/add", undefined, ResolutionMode.Import),
  );
  assertResponseText(
    response,
    `export function add(a, b) {
  return a + b;
}
`,
    { skipSourceMap: true },
  );
});
