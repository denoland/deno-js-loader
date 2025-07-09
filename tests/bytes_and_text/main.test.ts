import {
  assertResponseText,
  createLoader,
  RequestedModuleType,
  ResolutionMode,
  type WorkspaceOptions,
} from "../helpers.ts";

Deno.test("loads jsx transpiled", async () => {
  const mainTs = import.meta.dirname + "/testdata/main.ts";
  const createWorkspace = async (options?: WorkspaceOptions) => {
    return await createLoader({
      configPath: import.meta.dirname + "/testdata/deno.json",
      ...(options ?? {}),
    }, {
      entrypoints: [mainTs],
    });
  };
  const { loader } = await createWorkspace();

  const mainTsUrl = loader.resolve(mainTs, undefined, ResolutionMode.Import);
  const dataFileUrl = loader.resolve(
    "./data_utf8_bom.txt",
    mainTsUrl,
    ResolutionMode.Import,
  );

  assertResponseText(
    await loader.load(dataFileUrl, RequestedModuleType.Text),
    `Hello there!`,
  );
});
