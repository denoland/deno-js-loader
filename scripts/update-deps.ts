#!/usr/bin/env -S deno run -A
import $ from "@david/dax";
import * as toml from "@std/toml";

const rootDir = $.path(import.meta.dirname!).parentOrThrow();
const denoDir = rootDir.join("deno");

const oldCommit = (await $`git rev-parse HEAD`.cwd(denoDir).text()).trim();
$.logLight("Previous commit", oldCommit);
await $`git fetch --depth=1 origin`.cwd(denoDir);
await $`git checkout origin/HEAD`.cwd(denoDir);
const newCommit = (await $`git rev-parse HEAD`.cwd(denoDir).text()).trim();
$.logLight("New commit", newCommit);

const denoCargoTomlPath = denoDir.join("Cargo.toml");
const denoCargoToml = toml.parse(denoCargoTomlPath.readTextSync()) as any;
const denoDependencies = denoCargoToml.workspace.dependencies;

const localCargoTomlPath = rootDir.join("src/rs_lib/Cargo.toml");
const localCargoToml = toml.parse(localCargoTomlPath.readTextSync()) as any;

updateDependencies(localCargoToml.dependencies, denoDependencies);

// update target-specific dependencies
if (localCargoToml.target) {
  for (const targetDeps of Object.values(localCargoToml.target)) {
    if (
      targetDeps != null &&
      typeof targetDeps === "object" &&
      "dependencies" in targetDeps
    ) {
      updateDependencies(
        (targetDeps as any).dependencies,
        denoDependencies,
      );
    }
  }
}

function updateDependencies(
  localDeps: Record<string, any>,
  sourceDeps: Record<string, any>,
) {
  for (const [key, value] of Object.entries(localDeps)) {
    const newVersion = getVersion(sourceDeps[key]);
    if (newVersion == null) {
      continue;
    }
    if (typeof value === "string") {
      if (value !== newVersion) {
        $.logLight(`Updating ${key}@${value} to ${newVersion}`);
        localDeps[key] = newVersion;
      }
    } else if (
      value != null && typeof value === "object" && "version" in value
    ) {
      if (value.version !== newVersion) {
        $.logLight(`Updating ${key}@${value.version} to ${newVersion}`);
        value.version = newVersion;
      }
    }
  }
}

localCargoTomlPath.writeTextSync(
  toml.stringify(localCargoToml)
    .trimStart()
    .replace(
      "[dependencies]",
      "# update this by running ./scripts/update-deps.ts\n[dependencies]",
    ),
);

function getVersion(dep: any): string | undefined {
  if (typeof dep === "string") {
    return dep;
  } else if (dep != null && typeof dep.version === "string") {
    return dep.version;
  } else {
    return undefined;
  }
}
