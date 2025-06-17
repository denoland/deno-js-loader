import {
  assertResponseText,
  createLoader,
  ResolutionMode,
} from "../helpers.ts";
import { assert } from "@std/assert";

Deno.test("loads jsx transpiled", async () => {
  const mainJsx = import.meta.dirname + "/testdata/main.jsx";
  const mainTsx = import.meta.dirname + "/testdata/main.tsx";
  const { loader, workspace } = await createLoader({
    configPath: import.meta.dirname + "/testdata/deno.json",
  }, {
    entrypoints: [mainJsx],
  });

  const mainJsxSourceMappingURL =
    "//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1haW4uanN4Il0sInNvdXJjZXNDb250ZW50IjpbImNvbnNvbGUubG9nKDxkaXYgLz4pO1xuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7QUFBQSxRQUFRLEdBQUcifQ==";
  const mainTsxSourceMappingURL =
    "//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1haW4udHN4Il0sInNvdXJjZXNDb250ZW50IjpbImNvbnN0IHZhbHVlOiBzdHJpbmcgPSBcIlwiO1xuY29uc29sZS5sb2coPGRpdiAvPiwgdmFsdWUpO1xuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE1BQU0sUUFBZ0I7QUFDdEIsUUFBUSxHQUFHLEVBQUUsT0FBUSJ9";
  const mainJsxUrl = loader.resolve(mainJsx, undefined, ResolutionMode.Import);
  const mainTsxUrl = loader.resolve(mainTsx, undefined, ResolutionMode.Import);

  assertResponseText(
    await loader.load(mainJsxUrl),
    `import { jsxTemplate as _jsxTemplate } from "react/jsx-runtime";
const $$_tpl_1 = [
  "<div></div>"
];
console.log(_jsxTemplate($$_tpl_1));
${mainJsxSourceMappingURL}`,
  );

  // resolves jsx-dev
  const jsx = loader.resolve(
    "react/jsx-dev-runtime",
    mainTsx,
    ResolutionMode.Import,
  );
  assert(jsx.startsWith("file:"));

  {
    const newLoader = await workspace.createLoader({
      entrypoints: [mainJsx, mainTsxUrl],
      preserveJsx: true,
    });
    assertResponseText(
      await newLoader.load(mainJsxUrl),
      "console.log(<div />);\n",
    );
    assertResponseText(
      await newLoader.load(mainTsxUrl),
      `const value = "";\nconsole.log(<div/>, value);\n${mainTsxSourceMappingURL}`,
    );
  }
  {
    const newLoader = await workspace.createLoader({
      entrypoints: [mainJsx, mainTsx],
      noTranspile: true,
    });
    assertResponseText(
      await newLoader.load(mainJsxUrl),
      `console.log(<div />);\n`,
    );
    assertResponseText(
      await newLoader.load(mainTsxUrl),
      `const value: string = "";\nconsole.log(<div />, value);\n`,
    );
  }
});
