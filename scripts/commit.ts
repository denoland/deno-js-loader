import $ from "@david/dax";

const rootDir = $.path(import.meta.dirname!).parentOrThrow();
const denoDir = rootDir.join("deno");

const hasGitChanges = (await $`git status --porcelain`.text()).trim().length > 0;
if (!hasGitChanges) {
  $.log("Had no git changes. Exiting.");
  Deno.exit(0);
}

const newCommit = (await $`git rev-parse HEAD`.cwd(denoDir).text()).trim();
$.logStep("Updating to", newCommit);

await $`git add .`.cwd(rootDir);
const commitMessage = `chore: bumping to Deno ${newCommit}`;
await $`git commit -m ${commitMessage}`;
await $`git push`;
