import {
  assertResponseText,
  createLoader,
  RequestedModuleType,
} from "./helpers.ts";

Deno.test("loads from http server", async () => {
  await using server = Deno.serve((_request) => {
    return new Response("console.log(1);", {
      headers: {
        "content-type": "application/javascript",
      },
    });
  });

  const url = `http://localhost:${server.addr.port}/no-extension`;
  const { loader } = await createLoader({}, {
    entrypoints: [url],
  });

  const response = await loader.load(url, RequestedModuleType.Default);
  assertResponseText(
    response,
    `console.log(1);`,
  );
});
