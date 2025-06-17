import {
  type LoaderOptions,
  type LoadResponse,
  type ModuleLoadResponse,
  Workspace,
  type WorkspaceOptions,
} from "@deno/loader";
import { assertEquals } from "@std/assert";

export * from "@deno/loader";

export async function createLoader(
  workspaceOptions: WorkspaceOptions,
  loaderOptions: LoaderOptions,
) {
  const workspace = new Workspace(workspaceOptions);
  const loader = await workspace.createLoader(loaderOptions);
  return {
    loader,
    workspace,
  };
}

export function assertResponseText(
  response: LoadResponse,
  text: string,
  opts?: { skipSourceMap?: boolean },
) {
  assertEquals(response.kind, "module");
  const moduleResponse = response as ModuleLoadResponse;
  let actualText = new TextDecoder().decode(moduleResponse.code);
  if (opts?.skipSourceMap) {
    actualText = actualText.replace(
      /\/\/# sourceMappingURL=.*$/,
      "",
    );
  }
  assertEquals(actualText, text);
}
