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

import {
  DenoLoader as WasmLoader,
  DenoWorkspace as WasmWorkspace,
} from "./lib/rs_lib.js";

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
  /** Enable debug logs. */
  debug?: boolean;
}

/** Options for loading. */
export interface LoaderOptions {
  /** Entrypoints to create the loader for. */
  entrypoints: string[];
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
  #debug: boolean;

  /** Creates a `DenoWorkspace` with the provided options. */
  constructor(options: DenoWorkspaceOptions = {}) {
    this.#inner = new WasmWorkspace(options);
    this.#debug = options.debug ?? false;
  }

  [Symbol.dispose]() {
    this.#inner.free();
  }

  /** Creates a loader that uses this this workspace. */
  async createLoader(options: LoaderOptions): Promise<DenoLoader> {
    if (this.#debug) {
      console.error(
        `Creating loader for entrypoints:\n  ${
          options.entrypoints.join("\n  ")
        }`,
      );
    }
    const wasmLoader = await this.#inner.create_loader(options.entrypoints);
    return new DenoLoader(wasmLoader, this.#debug);
  }
}

/** A loader for resolving and loading urls. */
export class DenoLoader implements Disposable {
  #inner: WasmLoader;
  #debug: boolean;

  /** @internal */
  constructor(loader: WasmLoader, debug: boolean) {
    if (!(loader instanceof WasmLoader)) {
      throw new Error("Get the loader from the workspace.");
    }
    this.#inner = loader;
    this.#debug = debug;
  }

  [Symbol.dispose]() {
    this.#inner.free();
  }

  /** Resolves a specifier using the given referrer and resolution mode. */
  resolve(
    specifier: string,
    referrer: string | undefined,
    resolutionMode: ResolutionMode,
  ): string {
    if (this.#debug) {
      console.error(
        `Resolving '${specifier}' from '${referrer ?? "<undefined>"}' (${
          resolutionModeToString(resolutionMode)
        })`,
      );
    }
    const value = this.#inner.resolve(specifier, referrer, resolutionMode);
    if (this.#debug) {
      console.error(`Resolved to '${value}'`);
    }
    return value;
  }

  /** Loads a specifier. */
  load(specifier: string): Promise<LoadResponse> {
    if (this.#debug) {
      console.error(`Loading '${specifier}'`);
    }
    return this.#inner.load(specifier);
  }
}

function resolutionModeToString(mode: ResolutionMode) {
  switch (mode) {
    case ResolutionMode.Import:
      return "import";
    case ResolutionMode.Require:
      return "require";
    default: {
      const _assertNever: never = mode;
      return "unknown";
    }
  }
}
