import { assertEquals } from "@std/assert";
import {
  assertResponseText,
  createLoader,
  RequestedModuleType,
  ResolutionMode,
  type WorkspaceOptions,
} from "../helpers.ts";

Deno.test("loads bytes and text", async () => {
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

  const mainTsUrl = loader.resolveSync(
    mainTs,
    undefined,
    ResolutionMode.Import,
  );
  const dataFileUrl = loader.resolveSync(
    "./data_utf8_bom.txt",
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
