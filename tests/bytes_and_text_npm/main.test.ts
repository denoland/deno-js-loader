import { assertEquals } from "@std/assert";
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
    "package/data.txt",
    mainTsUrl,
    ResolutionMode.Import,
  );

  assertResponseText(
    await loader.load(dataFileUrl, RequestedModuleType.Text),
    `Hello there!`,
  );
  const bytesResponse = await loader.load(
    dataFileUrl,
    RequestedModuleType.Bytes,
  );
  if (bytesResponse.kind !== "module") {
    throw new Error("Fail");
  }
  assertEquals(bytesResponse.code, Deno.readFileSync(new URL(dataFileUrl)));
});
