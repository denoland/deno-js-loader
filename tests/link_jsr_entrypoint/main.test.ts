import {
  assertResponseText,
  createLoader,
  RequestedModuleType,
  ResolutionMode,
} from "../helpers.ts";

Deno.test("loads linked entrypoint", async () => {
  const mainFile = import.meta.dirname + "/testdata/main/main.ts";
  const { loader } = await createLoader({
    configPath: import.meta.resolve("./testdata/main/deno.json"),
  }, {
    entrypoints: [mainFile],
  });

  const response = await loader.load(
    loader.resolveSync("@denotest/add", undefined, ResolutionMode.Import),
    RequestedModuleType.Default,
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
