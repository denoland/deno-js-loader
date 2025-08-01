import {
  type LoadResponse,
  type ModuleLoadResponse,
  Workspace,
  type WorkspaceOptions,
} from "@deno/loader";
import { assertEquals } from "@std/assert";

export * from "@deno/loader";

export async function createLoader(
  workspaceOptions: WorkspaceOptions,
  loaderOptions: { entrypoints: string[] },
) {
  const { loader, workspace, diagnostics } = await createLoaderWithDiagnostics(
    workspaceOptions,
    loaderOptions,
  );
  assertEquals(diagnostics, []);
  return {
    loader,
    workspace,
  };
}

export async function createLoaderWithDiagnostics(
  workspaceOptions: WorkspaceOptions,
  loaderOptions: { entrypoints: string[] },
) {
  const workspace = new Workspace(workspaceOptions);
  const loader = await workspace.createLoader();
  const diagnostics = await loader.addEntrypoints(loaderOptions.entrypoints);
  return {
    loader,
    workspace,
    diagnostics,
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
