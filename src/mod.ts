/**
 * Resolver and loader for Deno code.
 *
 * This can be used to create bundler plugins or libraries that use deno resolution.
 *
 * @example
 * ```ts
 * import { Workspace, ResolutionMode, type LoadResponse, RequestedModuleType } from "@deno/loader";
 *
 * const workspace = new Workspace({
 *   // optional options
 * });
 * const { loader, diagnostics } = await workspace.createLoader({
 *   entrypoints: ["./mod.ts"]
 * });
 * if (diagnostics.length > 0) {
 *   throw new Error(diagnostics[0].message);
 * }
 * // alternatively use resolveAsync to resolve npm/jsr specifiers not found
 * // in the entrypoints or if not being able to provide entrypoints
 * const resolvedUrl = loader.resolve(
 *   "./mod.test.ts",
 *   "https://deno.land/mod.ts", // referrer
 *   ResolutionMode.Import,
 * );
 * const response = await loader.load(resolvedUrl, RequestedModuleType.Default);
 * if (response.kind === "module") {
 *   console.log(response.specifier);
 *   console.log(response.code);
 *   console.log(response.mediaType);
 * } else if (response.kind === "external") {
 *   console.log(response.specifier)
 * } else {
 *   const _assertNever = response;
 *   throw new Error(`Unhandled kind: ${(response as LoadResponse).kind}`);
 * }
 * ```
 * @module
 */

import {
  DenoLoader as WasmLoader,
  DenoWorkspace as WasmWorkspace,
} from "./lib/rs_lib.js";

/** Options for creating a workspace. */
export interface WorkspaceOptions {
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
  /** Whether to preserve JSX syntax in the loaded output. */
  preserveJsx?: boolean;
  /** Skip transpiling TypeScript and JSX. */
  noTranspile?: boolean;
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
export type LoadResponse = ModuleLoadResponse | ExternalLoadResponse;

/** A response that indicates the module is external.
 *
 * This will occur for `node:` specifiers for example.
 */
export interface ExternalLoadResponse {
  /** Kind of response. */
  kind: "external";
  /**
   * Fully resolved URL.
   *
   * This may be different than the provided specifier. For example, during loading
   * it may encounter redirects and this specifier is the redirected to final specifier.
   */
  specifier: string;
}

/** A response that loads a module. */
export interface ModuleLoadResponse {
  /** Kind of response. */
  kind: "module";
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
export class Workspace implements Disposable {
  #inner: WasmWorkspace;
  #debug: boolean;

  /** Creates a `DenoWorkspace` with the provided options. */
  constructor(options: WorkspaceOptions = {}) {
    this.#inner = new WasmWorkspace(options);
    this.#debug = options.debug ?? false;
  }

  [Symbol.dispose]() {
    this.#inner.free();
  }

  /** Creates a loader that uses this this workspace. */
  async createLoader(
    options: LoaderOptions,
  ): Promise<{ loader: Loader; diagnostics: EntrypointDiagnostic[] }> {
    if (this.#debug) {
      console.error(
        `Creating loader for entrypoints:\n  ${
          options.entrypoints.join("\n  ")
        }`,
      );
    }
    const wasmLoader = await this.#inner.create_loader();
    const loader = new Loader(wasmLoader, this.#debug);
    const diagnostics = await loader.addEntrypoints(options.entrypoints);
    return { loader, diagnostics };
  }
}

export enum RequestedModuleType {
  Default = 0,
  Json = 1,
  Text = 2,
  Bytes = 3,
}

export interface EntrypointDiagnostic {
  message: string;
}

/** A loader for resolving and loading urls. */
export class Loader implements Disposable {
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

  /** Adds additional entrypoints to the loader after the fact.
   *
   * This may be useful for having a JSR specifier asynchronously
   * stored in the internal module graph on the fly, which will allow
   * it to be synchronously resolved.
   */
  async addEntrypoints(
    entrypoints: string[],
  ): Promise<EntrypointDiagnostic[]> {
    const messages = await this.#inner.add_entrypoints(entrypoints);
    return messages.map((message) => ({ message }));
  }

  /** Synchronously resolves a specifier using the given referrer and resolution mode. */
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

  /** Asynchronously resolves a specifier using the given referrer and resolution mode.
   *
   * This is useful for resolving `jsr:` and `npm:` specifiers on the fly when they can't
   * be figured out from entrypoints, but it may cause multiple "npm install"s and different
   * npm or jsr resolution than Deno. For that reason it's better to provide the list of
   * entrypoints up front so the loader can create the npm and jsr graph, and then after use
   * synchronous resolution to resolve jsr and npm specifiers.
   */
  resolveAsync(
    specifier: string,
    referrer: string | undefined,
    resolutionMode: ResolutionMode,
  ): Promise<string> {
    // note: this function breaks typical JS naming conventions because it is
    // preferred that people use resolve instead of resolveAsync
    if (this.#debug) {
      console.error(
        `Resolving '${specifier}' from '${referrer ?? "<undefined>"}' (${
          resolutionModeToString(resolutionMode)
        })`,
      );
    }
    const value = this.#inner.resolve_async(
      specifier,
      referrer,
      resolutionMode,
    );
    if (this.#debug) {
      console.error(`Resolved to '${value}'`);
    }
    return value;
  }

  /** Loads a specifier. */
  load(
    specifier: string,
    requestedModuleType: RequestedModuleType,
  ): Promise<LoadResponse> {
    if (this.#debug) {
      console.error(
        `Loading '${specifier}' with type '${
          requestedModuleTypeToString(requestedModuleType) ?? "<default>"
        }'`,
      );
    }
    return this.#inner.load(specifier, requestedModuleType);
  }

  /** Gets the module graph.
   *
   * WARNING: This function is very unstable and the output may change between
   * patch releases.
   */
  getGraphUnstable(): unknown {
    return this.#inner.get_graph();
  }
}

function requestedModuleTypeToString(moduleType: RequestedModuleType) {
  switch (moduleType) {
    case RequestedModuleType.Bytes:
      return "bytes";
    case RequestedModuleType.Text:
      return "text";
    case RequestedModuleType.Json:
      return "json";
    case RequestedModuleType.Default:
      return undefined;
    default: {
      const _never: never = moduleType;
      return undefined;
    }
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
