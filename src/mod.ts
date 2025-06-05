import { DenoLoader as WasmLoader, DenoWorkspace as WasmWorkspace } from "./lib/rs_lib.js";

export interface LoadResponse {
  /**
   * Fully resolved URL.
   * 
   * This may be different than the provided specifier. For example, during loading
   * it may encounter redirects and this specifier is the redirected to final specifier.
   */
  specifier: string;
  /** Content that was loaded. */
  mediaType: MediaType;
  /** Code that was loaded. */
  code: Uint8Array;
}

export interface LoaderOptions {
  entrypoints: string[]
}

export interface DenoWorkspaceOptions {
  noConfig?: boolean;
  noLock?: boolean;
  configPath?: string;
  nodeConditions?: string[];
  cachedOnly?: boolean;
}

/** File type. */
export enum MediaType {
  JavaScript = 0,
  Jsx = 1,
  Mjs = 2,
  Cjs = 3,
  TypeScript = 4,
  Mts = 5,
  Cts = 6,
  Dts = 7,
  Dmts = 8,
  Dcts = 9,
  Tsx = 10,
  Css = 11,
  Json = 12,
  Html = 13,
  Sql = 14,
  Wasm = 15,
  SourceMap = 16,
  Unknown = 17,
}

export enum ResolutionMode {
  Require = 0,
  Import = 1,
}

export class DenoWorkspace implements Disposable {
  #inner: WasmWorkspace;

  constructor(options: DenoWorkspaceOptions = {}) {
    this.#inner = new WasmWorkspace(options);
  }

  [Symbol.dispose]() {
    this.#inner.free();
  }

  async createLoader(options: LoaderOptions): Promise<DenoLoader> {
    const wasmLoader = await this.#inner.create_loader(options.entrypoints);
    return new DenoLoader(wasmLoader);
  }
}

export class DenoLoader implements Disposable {
  #inner: WasmLoader;

  /** @internal */
  constructor(loader: WasmLoader) {
    if (!(loader instanceof WasmLoader)) {
      throw new Error("Get the loader from the workspace.");
    }
    this.#inner = loader;
  }

  [Symbol.dispose]() {
    this.#inner.free();
  }

  resolve(specifier: string, referrer: string | undefined, resolutionMode: ResolutionMode): string {
    return this.#inner.resolve(specifier, referrer, resolutionMode)
  }

  load(specifier: string): Promise<LoadResponse> {
    return this.#inner.load(specifier);
  }
}
