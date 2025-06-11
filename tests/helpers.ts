import { Workspace, type WorkspaceOptions, type LoaderOptions, type LoadResponse, type ModuleLoadResponse } from "@deno/loader";
import { assertEquals } from "@std/assert";

export * from "@deno/loader";

export async function createLoader(workspaceOptions: WorkspaceOptions, loaderOptions: LoaderOptions) {
  const workspace = new Workspace(workspaceOptions);
  const loader = await workspace.createLoader(loaderOptions);
  return {
    loader,
    workspace
  };
}

export function assertResponseText(response: LoadResponse, text: string) {
  assertEquals(response.kind, "module");
  const moduleResponse = response as ModuleLoadResponse;
  assertEquals(new TextDecoder().decode(moduleResponse.code), text);
}