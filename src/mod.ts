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
 * const loader = await workspace.createLoader();
 * const diagnostics = await loader.addEntrypoints(["./mod.ts"])
 * if (diagnostics.length > 0) {
 *   throw new Error(diagnostics[0].message);
 * }
 * // alternatively use resolve to resolve npm/jsr specifiers not found
 * // in the entrypoints or if not being able to provide entrypoints
 * const resolvedUrl = loader.resolveSync(
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
  /** Path or file: URL to the config file if you do not want to do config file discovery. */
  configPath?: string;
  /** Node resolution conditions to use for resolving package.json exports. */
  nodeConditions?: string[];
  /**
   * Platform to bundle for.
   * @default "node"
   */
  platform?: "node" | "browser";
  /** Whether to force using the cache. */
  cachedOnly?: boolean;
  /**
   * Enable debug logs.
   *
   * @remarks Note that the Rust debug logs are enabled globally
   * and can only be enabled by the first workspace that gets
   * created. This is a limitation of how the Rust logging works.
   */
  debug?: boolean;
  /** Whether to preserve JSX syntax in the loaded output. */
  preserveJsx?: boolean;
  /** Skip transpiling TypeScript and JSX. */
  noTranspile?: boolean;
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
  async createLoader(): Promise<Loader> {
    const wasmLoader = await this.#inner.create_loader();
    return new Loader(wasmLoader, this.#debug);
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

  /** Adds entrypoints to the loader.
   *
   * It's useful to specify entrypoints so that the loader can resolve
   * npm: and jsr: specifiers the same way that Deno does when not using
   * a lockfile.
   */
  async addEntrypoints(
    entrypoints: string[],
  ): Promise<EntrypointDiagnostic[]> {
    const messages = await this.#inner.add_entrypoints(entrypoints);
    return messages.map((message) => ({ message }));
  }

  /** Synchronously resolves a specifier using the given referrer and resolution mode. */
  resolveSync(
    specifier: string,
    referrer: string | undefined,
    resolutionMode: ResolutionMode,
  ): string {
    if (this.#debug) {
      console.error(
        `DEBUG - Resolving '${specifier}' from '${
          referrer ?? "<undefined>"
        }' (${resolutionModeToString(resolutionMode)})`,
      );
    }
    const value = this.#inner.resolve_sync(specifier, referrer, resolutionMode);
    if (this.#debug) {
      console.error(`DEBUG - Resolved to '${value}'`);
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
  async resolve(
    specifier: string,
    referrer: string | undefined,
    resolutionMode: ResolutionMode,
  ): Promise<string> {
    if (this.#debug) {
      console.error(
        `DEBUG - Resolving '${specifier}' from '${
          referrer ?? "<undefined>"
        }' (${resolutionModeToString(resolutionMode)})`,
      );
    }
    const value = await this.#inner.resolve(
      specifier,
      referrer,
      resolutionMode,
    );
    if (this.#debug) {
      console.error(`DEBUG - Resolved to '${value}'`);
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
        `DEBUG - Loading '${specifier}' with type '${
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
