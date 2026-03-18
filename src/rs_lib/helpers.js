export async function fetch_specifier(specifier, headers, clientCertConfig) {
  let client;
  try {
    console.error("Downloading", specifier);
    const options = {
      headers,
      redirect: "manual",
    };

    if (clientCertConfig) {
      client = await createClientCertHttpClient(clientCertConfig);
      if (client) {
        options.client = client;
      }
    }

    const response = await fetch(specifier, options);
    const status = response.status;
    const body = await response.bytes();
    return {
      status,
      body,
      headers: response.headers,
    };
  } catch (err) {
    return {
      error: err.toString(),
    };
  } finally {
    if (client) {
      client.close();
    }
  }
}

async function createClientCertHttpClient(config) {
  if (typeof Deno !== "undefined" && Deno.createHttpClient) {
    const certChain = await Deno.readTextFile(config.certfile);
    const privateKey = await Deno.readTextFile(config.keyfile);
    return Deno.createHttpClient({ certChain, privateKey });
  }
  return undefined;
}
