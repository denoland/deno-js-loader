import { DenoLoader as WasmLoader, DenoWorkspace as WasmWorkspace } from "./lib/rs_lib.js";

/**
 * Resolver and loader for Deno code.
 *
 * This can be used to create bundler plugins or libraries that use deno resolution.
 *
 * @example
 * ```ts
 * import { DenoWorkspace, ResolutionMode } from "@deno/loader";
 * 
 * const workspace = new DenoWorkspace({
 *   // optional options
 * });
 * const loader = workspace.createLoader({
 *   entrypoints: ["./mod.ts"]
 * });
 * const resolvedUrl = loader.resolve(
 *   "./mod.test.ts",
 *   "https://deno.land/mod.ts", // referrer
 *   ResolutionMode.Import,
 * );
 * const loadedModule = await loader.load(resolvedUrl);
 * console.log(loadedModule.specifier);
 * console.log(loadedModule.code);
 * console.log(loadedModule.mediaType);
 * ```
 * @module
 */

/** Options for creating a workspace. */
export interface DenoWorkspaceOptions {
  /** Do not do config file discovery. */
  noConfig?: boolean;
  /** Do not respect the lockfile. */
  noLock?: boolean;
  /** Path to the config file if you do not want to do config file discovery. */
  configPath?: string;
  /** Node resolution conditions to use for resolving package.json exports. */
  nodeConditions?: string[];
  /** Whether to force using the cache. */
  cachedOnly?: boolean;
}

/** Options for loading. */
export interface LoaderOptions {
  /** Entrypoints to create the loader for. */
  entrypoints: string[]
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

/** A response received from a load. */
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

/** Kind of resolution. */
export enum ResolutionMode {
  /** Resolving from an ESM file. */
  Import = 0,
  /** Resolving from a CJS file. */
  Require = 1,
}

/** Resolves the workspace. */
export class DenoWorkspace implements Disposable {
  #inner: WasmWorkspace;

  /** Creates a `DenoWorkspace` with the provided options. */
  constructor(options: DenoWorkspaceOptions = {}) {
    this.#inner = new WasmWorkspace(options);
  }

  [Symbol.dispose]() {
    this.#inner.free();
  }

  /** Creates a loader that uses this this workspace. */
  async createLoader(options: LoaderOptions): Promise<DenoLoader> {
    const wasmLoader = await this.#inner.create_loader(options.entrypoints);
    return new DenoLoader(wasmLoader);
  }
}

/** A loader for resolving and loading urls. */
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

  /** Resolves a specifier using the given referrer and resolution mode. */
  resolve(specifier: string, referrer: string | undefined, resolutionMode: ResolutionMode): string {
    return this.#inner.resolve(specifier, referrer, resolutionMode)
  }

  /** Loads a specifier. */
  load(specifier: string): Promise<LoadResponse> {
    return this.#inner.load(specifier);
  }
}
