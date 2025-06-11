mod http_client;

use std::borrow::Cow;
use std::path::Path;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;

use anyhow::bail;
use deno_ast::ModuleKind;
use deno_ast::TranspileModuleOptions;
use deno_ast::TranspileOptions;
use deno_cache_dir::file_fetcher::CacheSetting;
use deno_cache_dir::file_fetcher::NullBlobStore;
use deno_graph::MediaType;
use deno_graph::Module;
use deno_graph::ModuleGraph;
use deno_graph::analysis::ModuleAnalyzer;
use deno_graph::ast::DefaultModuleAnalyzer;
use deno_graph::ast::EsParser;
use deno_graph::ast::ParseOptions;
use deno_graph::ast::ParsedSourceStore;
use deno_npm_installer::NpmInstallerFactory;
use deno_npm_installer::NpmInstallerFactoryOptions;
use deno_npm_installer::Reporter;
use deno_npm_installer::lifecycle_scripts::NullLifecycleScriptsExecutor;
use deno_resolver::cjs::CjsTrackerRc;
use deno_resolver::deno_json::TsConfigResolverRc;
use deno_resolver::factory::ConfigDiscoveryOption;
use deno_resolver::factory::NpmSystemInfo;
use deno_resolver::factory::ResolverFactory;
use deno_resolver::factory::ResolverFactoryOptions;
use deno_resolver::factory::WorkspaceFactory;
use deno_resolver::factory::WorkspaceFactoryOptions;
use deno_resolver::file_fetcher::DenoGraphLoader;
use deno_resolver::file_fetcher::DenoGraphLoaderOptions;
use deno_resolver::file_fetcher::PermissionedFileFetcher;
use deno_resolver::file_fetcher::PermissionedFileFetcherOptions;
use deno_resolver::graph::DefaultDenoResolverRc;
use deno_resolver::npm::DenoInNpmPackageChecker;
use deno_resolver::workspace::ScopedJsxImportSourceConfig;
use deno_semver::SmallStackString;
use js_sys::Object;
use js_sys::Uint8Array;
use node_resolver::NodeConditionOptions;
use node_resolver::NodeResolverOptions;
use node_resolver::PackageJsonThreadLocalCache;
use node_resolver::cache::NodeResolutionThreadLocalCache;
use serde::Deserialize;
use serde::Serialize;
use sys_traits::EnvCurrentDir;
use sys_traits::impls::RealSys;
use url::Url;
use wasm_bindgen::JsValue;
use wasm_bindgen::prelude::wasm_bindgen;

use self::http_client::WasmHttpClient;

#[wasm_bindgen]
extern "C" {
  #[wasm_bindgen(thread_local_v2, js_name = process)]
  static PROCESS_GLOBAL: JsValue;
  #[wasm_bindgen(js_namespace = console)]
  fn error(s: &JsValue);
}

#[derive(Debug, Clone)]
pub struct ConsoleLogReporter;

impl Reporter for ConsoleLogReporter {
  type Guard = ();
  type ClearGuard = ();

  fn on_blocking(&self, message: &str) -> Self::Guard {
    error(&JsValue::from(format!(
      "{} {}",
      "Blocking", // todo: cyan
      message
    )));
  }

  fn on_initializing(&self, message: &str) -> Self::Guard {
    error(&JsValue::from(format!(
      "{} {}",
      "Initialize", // todo: green
      message
    )));
  }

  fn clear_guard(&self) -> Self::ClearGuard {}
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadResponse {
  pub specifier: String,
  pub media_type: u8,
  pub code: Arc<[u8]>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoaderOptions {
  #[serde(default)]
  pub no_transpile: Option<bool>,
  #[serde(default)]
  pub preserve_jsx: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DenoWorkspaceOptions {
  // make all these optional to support someone providing `undefined`
  #[serde(default)]
  pub no_config: Option<bool>,
  #[serde(default)]
  pub no_lock: Option<bool>,
  #[serde(default)]
  pub config_path: Option<String>,
  #[serde(default)]
  pub node_conditions: Option<Vec<String>>,
  #[serde(default)]
  pub cached_only: Option<bool>,
}

#[wasm_bindgen]
pub struct DenoWorkspace {
  http_client: WasmHttpClient,
  npm_installer_factory:
    Arc<NpmInstallerFactory<WasmHttpClient, ConsoleLogReporter, RealSys>>,
  resolver_factory: Arc<ResolverFactory<RealSys>>,
  workspace_factory: Arc<WorkspaceFactory<RealSys>>,
}

impl Drop for DenoWorkspace {
  fn drop(&mut self) {
    PackageJsonThreadLocalCache::clear();
  }
}

#[wasm_bindgen]
impl DenoWorkspace {
  #[wasm_bindgen(constructor)]
  pub fn new(options: JsValue) -> Result<Self, JsValue> {
    console_error_panic_hook::set_once();
    let options = serde_wasm_bindgen::from_value(options).map_err(|err| {
      create_js_error(
        anyhow::anyhow!("{}", err)
          .context("Failed deserializing workspace options."),
      )
    })?;
    Self::new_inner(options).map_err(create_js_error)
  }

  fn new_inner(options: DenoWorkspaceOptions) -> Result<Self, anyhow::Error> {
    let sys = RealSys;
    let cwd = sys.env_current_dir()?;
    let config_discovery = if options.no_config.unwrap_or_default() {
      ConfigDiscoveryOption::Disabled
    } else if let Some(config_path) = options.config_path {
      ConfigDiscoveryOption::Path(resolve_absolute_path(config_path, &cwd))
    } else {
      ConfigDiscoveryOption::DiscoverCwd
    };
    let workspace_factory = Arc::new(WorkspaceFactory::new(
      sys.clone(),
      cwd,
      WorkspaceFactoryOptions {
        additional_config_file_names: &[],
        config_discovery,
        deno_dir_path_provider: None,
        is_package_manager_subcommand: false,
        frozen_lockfile: None, // provide this via config
        lock_arg: None,        // supports the default only
        lockfile_skip_write: false,
        node_modules_dir: None, // provide this via config
        no_lock: options.no_lock.unwrap_or_default(),
        no_npm: false,
        npm_process_state: None,
        vendor: None, // provide this via the config
      },
    ));
    let resolver_factory = Arc::new(ResolverFactory::new(
      workspace_factory.clone(),
      ResolverFactoryOptions {
        // todo: make this configurable
        is_cjs_resolution_mode:
          deno_resolver::cjs::IsCjsResolutionMode::ExplicitTypeCommonJs,
        unstable_sloppy_imports: true,
        npm_system_info: npm_system_info()?,
        node_resolver_options: NodeResolverOptions {
          conditions: NodeConditionOptions {
            conditions: options
              .node_conditions
              .unwrap_or_default()
              .into_iter()
              .map(|c| c.into())
              .collect(),
            import_conditions_override: None,
            require_conditions_override: None,
          },
          typescript_version: None,
        },
        node_resolution_cache: Some(Arc::new(NodeResolutionThreadLocalCache)),
        package_json_cache: Some(Arc::new(PackageJsonThreadLocalCache)),
        package_json_dep_resolution: None,
        specified_import_map: None,
        bare_node_builtins: true,
        // todo: report these
        on_mapped_resolution_diagnostic: None,
      },
    ));
    let http_client = WasmHttpClient::default();
    let npm_installer_factory = Arc::new(NpmInstallerFactory::new(
      resolver_factory.clone(),
      Arc::new(http_client.clone()),
      Arc::new(NullLifecycleScriptsExecutor),
      ConsoleLogReporter,
      NpmInstallerFactoryOptions {
        cache_setting: if options.cached_only.unwrap_or_default() {
          deno_npm_cache::NpmCacheSetting::Only
        } else {
          deno_npm_cache::NpmCacheSetting::Use
        },
        caching_strategy: deno_npm_installer::graph::NpmCachingStrategy::Eager,
        lifecycle_scripts_config: deno_npm_installer::LifecycleScriptsConfig {
          allowed: deno_npm_installer::PackagesAllowedScripts::None,
          initial_cwd: workspace_factory.initial_cwd().clone(),
          root_dir: workspace_factory
            .workspace_directory()?
            .workspace
            .root_dir_path(),
          explicit_install: false,
        },
        resolve_npm_resolution_snapshot: Box::new(|| Ok(None)),
      },
    ));
    Ok(Self {
      http_client,
      npm_installer_factory,
      resolver_factory,
      workspace_factory,
    })
  }

  pub async fn create_loader(
    &self,
    options: JsValue,
  ) -> Result<DenoLoader, JsValue> {
    let options = serde_wasm_bindgen::from_value(options).map_err(|err| {
      create_js_error(
        anyhow::anyhow!("{}", err)
          .context("Failed deserializing loader options."),
      )
    })?;
    self
      .create_loader_inner(options)
      .await
      .map_err(create_js_error)
  }

  async fn create_loader_inner(
    &self,
    options: LoaderOptions,
  ) -> Result<DenoLoader, anyhow::Error> {
    self
      .npm_installer_factory
      .initialize_npm_resolution_if_managed()
      .await?;
    let file_fetcher = Arc::new(PermissionedFileFetcher::new(
      NullBlobStore,
      Arc::new(self.workspace_factory.http_cache()?.clone()),
      self.http_client.clone(),
      self.workspace_factory.sys().clone(),
      PermissionedFileFetcherOptions {
        allow_remote: true,
        cache_setting: CacheSetting::Use,
      },
    ));
    Ok(DenoLoader {
      cjs_tracker: self.resolver_factory.cjs_tracker()?.clone(),
      file_fetcher,
      resolver: self.resolver_factory.deno_resolver().await?.clone(),
      workspace_factory: self.workspace_factory.clone(),
      resolver_factory: self.resolver_factory.clone(),
      npm_installer_factory: self.npm_installer_factory.clone(),
      tsconfig_resolver: self.workspace_factory.tsconfig_resolver()?.clone(),
      capturing_analyzer: if options.no_transpile.unwrap_or(false) {
        None
      } else {
        Some(Default::default())
      },
      task_queue: Default::default(),
      preserve_jsx: options.preserve_jsx.unwrap_or(false),
      graph: deno_graph::ModuleGraph::new(deno_graph::GraphKind::CodeOnly),
    })
  }
}

#[wasm_bindgen]
pub struct DenoLoader {
  cjs_tracker: CjsTrackerRc<DenoInNpmPackageChecker, RealSys>,
  resolver: DefaultDenoResolverRc<RealSys>,
  file_fetcher:
    Arc<PermissionedFileFetcher<NullBlobStore, RealSys, WasmHttpClient>>,
  npm_installer_factory:
    Arc<NpmInstallerFactory<WasmHttpClient, ConsoleLogReporter, RealSys>>,
  resolver_factory: Arc<ResolverFactory<RealSys>>,
  tsconfig_resolver: TsConfigResolverRc<RealSys>,
  workspace_factory: Arc<WorkspaceFactory<RealSys>>,
  graph: ModuleGraph,
  capturing_analyzer: Option<deno_graph::ast::CapturingModuleAnalyzer>,
  task_queue: Rc<deno_unsync::TaskQueue>,
  preserve_jsx: bool,
}

impl Drop for DenoLoader {
  fn drop(&mut self) {
    NodeResolutionThreadLocalCache::clear();
  }
}

#[wasm_bindgen]
impl DenoLoader {
  pub async fn add_roots(&mut self, roots: Vec<String>) -> Result<(), JsValue> {
    // only allow one async task to modify the graph at a time
    let task_queue = self.task_queue.clone();
    task_queue
      .run(async { self.add_roots_inner(roots).await.map_err(create_js_error) })
      .await
  }

  async fn add_roots_inner(
    &mut self,
    roots: Vec<String>,
  ) -> Result<(), anyhow::Error> {
    let cwd = self.workspace_factory.initial_cwd();
    let roots = roots
      .into_iter()
      .map(|e| parse_entrypoint(e, &cwd))
      .collect::<Result<Vec<_>, _>>()?;
    let npm_package_info_provider = self
      .npm_installer_factory
      .lockfile_npm_package_info_provider()?;
    let lockfile = self
      .workspace_factory
      .maybe_lockfile(npm_package_info_provider)
      .await?;
    let jsx_config = ScopedJsxImportSourceConfig::from_workspace_dir(
      self.workspace_factory.workspace_directory()?,
    )?;

    let graph_resolver = self
      .resolver
      .as_graph_resolver(&self.cjs_tracker, &jsx_config);
    let loader = DenoGraphLoader::new(
      self.file_fetcher.clone(),
      self.workspace_factory.global_http_cache()?.clone(),
      self.resolver_factory.in_npm_package_checker()?.clone(),
      self.workspace_factory.sys().clone(),
      DenoGraphLoaderOptions {
        file_header_overrides: Default::default(),
        permissions: None,
      },
    );

    let mut locker = lockfile.as_ref().map(|l| l.as_deno_graph_locker());
    let npm_resolver =
      self.npm_installer_factory.npm_deno_graph_resolver().await?;
    let module_analyzer = DefaultModuleAnalyzer::default();
    let module_analyzer = self
      .capturing_analyzer
      .as_ref()
      .map(|a| a as &dyn ModuleAnalyzer)
      .unwrap_or(&module_analyzer);
    self
      .graph
      .build(
        roots,
        Vec::new(),
        &loader,
        deno_graph::BuildOptions {
          is_dynamic: false,
          skip_dynamic_deps: false,
          module_info_cacher: Default::default(),
          executor: Default::default(),
          locker: locker.as_mut().map(|l| l as _),
          file_system: self.workspace_factory.sys(),
          jsr_url_provider: Default::default(),
          passthrough_jsr_specifiers: false,
          module_analyzer,
          npm_resolver: Some(npm_resolver.as_ref()),
          reporter: None,
          resolver: Some(&graph_resolver),
        },
      )
      .await;
    self.graph.valid()?;
    Ok(())
  }

  pub fn resolve(
    &self,
    specifier: String,
    importer: Option<String>,
    resolution_mode: u8,
  ) -> Result<String, JsValue> {
    let resolution_mode = match resolution_mode {
      1 => node_resolver::ResolutionMode::Require,
      _ => node_resolver::ResolutionMode::Import,
    };
    self
      .resolve_inner(specifier, importer, resolution_mode)
      .map_err(create_js_error)
  }

  fn resolve_inner(
    &self,
    specifier: String,
    importer: Option<String>,
    resolution_mode: node_resolver::ResolutionMode,
  ) -> Result<String, anyhow::Error> {
    let importer = importer.filter(|v| !v.is_empty());
    let (specifier, referrer) = match importer {
      Some(referrer)
        if referrer.starts_with("http:")
          || referrer.starts_with("https:")
          || referrer.starts_with("file:") =>
      {
        (specifier, Url::parse(&referrer)?)
      }
      Some(referrer) => (
        specifier,
        deno_path_util::url_from_file_path(
          &sys_traits::impls::wasm_string_to_path(referrer),
        )?,
      ),
      None => {
        let entrypoint =
          parse_entrypoint(specifier, self.workspace_factory.initial_cwd())?
            .to_string();
        (
          entrypoint,
          deno_path_util::url_from_file_path(
            self.workspace_factory.initial_cwd(),
          )?,
        )
      }
    };
    let resolved = self.resolver.resolve_with_graph(
      &self.graph,
      &specifier,
      &referrer,
      deno_graph::Position::zeroed(),
      resolution_mode,
      node_resolver::NodeResolutionKind::Execution,
    )?;
    Ok(resolved.to_string())
  }

  pub async fn load(&self, url: String) -> Result<JsValue, JsValue> {
    self.load_inner(url).await.map_err(create_js_error)
  }

  async fn load_inner(&self, url: String) -> Result<JsValue, anyhow::Error> {
    let url = Url::parse(&url)?;

    match self.graph.get(&url) {
      Some(Module::Js(m)) => Ok(create_module_response(
        &m.specifier,
        m.media_type,
        &self.maybe_transpile(
          &m.specifier,
          m.media_type,
          &m.source,
          Some(m.is_script),
        )?,
      )),
      Some(Module::Json(m)) => Ok(create_module_response(
        &m.specifier,
        MediaType::Json,
        m.source.as_bytes(),
      )),
      Some(Module::Wasm(m)) => Ok(create_module_response(
        &m.specifier,
        MediaType::Wasm,
        &m.source,
      )),
      Some(Module::Node(m)) => Ok(create_external_repsonse(&m.specifier)),
      Some(Module::Npm(_)) => {
        bail!(
          "Failed resolving '{}'\n\nResolve the npm: specifier to a file: specifier before providing it to the loader.",
          url
        )
      }
      None if url.scheme() == "node" => Ok(create_external_repsonse(&url)),
      Some(Module::External(_)) | None => {
        let file = self.file_fetcher.fetch_bypass_permissions(&url).await?;
        let media_type = MediaType::from_specifier_and_headers(
          &url,
          file.maybe_headers.as_ref(),
        );

        if media_type.is_emittable() {
          let str = String::from_utf8_lossy(&file.source);
          let value = str.into();
          let source =
            self.maybe_transpile(&file.url, media_type, &value, None)?;
          Ok(create_module_response(&file.url, media_type, &source))
        } else {
          Ok(create_module_response(&file.url, media_type, &file.source))
        }
      }
    }
  }

  fn should_emit(&self, media_type: MediaType) -> bool {
    if media_type == MediaType::Jsx && self.preserve_jsx {
      false
    } else {
      media_type.is_emittable()
    }
  }

  fn maybe_transpile<'a>(
    &self,
    specifier: &Url,
    media_type: MediaType,
    source: &'a Arc<str>,
    is_known_script: Option<bool>,
  ) -> Result<Cow<'a, [u8]>, anyhow::Error> {
    let Some(capturing_analyzer) = &self.capturing_analyzer else {
      return Ok(Cow::Borrowed(source.as_bytes()));
    };
    if self.should_emit(media_type) {
      let parsed_source = capturing_analyzer
        .as_capturing_parser()
        .parse_program(ParseOptions {
          specifier,
          source: source.clone(),
          media_type,
          scope_analysis: false,
        })?;
      capturing_analyzer.remove_parsed_source(specifier); // remove from memory
      let transpile_and_emit_options = self
        .tsconfig_resolver
        .transpile_and_emit_options(specifier)?;
      let is_cjs = if let Some(is_known_script) = is_known_script {
        self.cjs_tracker.is_cjs_with_known_is_script(
          specifier,
          media_type,
          is_known_script,
        )?
      } else {
        self.cjs_tracker.is_maybe_cjs(specifier, media_type)?
          && parsed_source.compute_is_script()
      };
      let transpile_options = if self.preserve_jsx
        && transpile_and_emit_options.transpile.transform_jsx
      {
        Cow::Owned(TranspileOptions {
          transform_jsx: false,
          ..transpile_and_emit_options.transpile.clone()
        })
      } else {
        Cow::Borrowed(&transpile_and_emit_options.transpile)
      };
      Ok(Cow::Owned(
        parsed_source
          .transpile(
            &transpile_options,
            &TranspileModuleOptions {
              module_kind: Some(ModuleKind::from_is_cjs(is_cjs)),
            },
            &transpile_and_emit_options.emit,
          )?
          .into_source()
          .text
          .into_bytes(),
      ))
    } else {
      Ok(Cow::Borrowed(source.as_bytes()))
    }
  }
}

fn create_module_response(
  url: &Url,
  media_type: MediaType,
  source: &[u8],
) -> JsValue {
  let obj = Object::new();
  js_sys::Reflect::set(
    &obj,
    &JsValue::from_str("kind"),
    &JsValue::from_str("module"),
  )
  .unwrap();
  let specifier = JsValue::from_str(url.as_str());
  js_sys::Reflect::set(&obj, &JsValue::from_str("specifier"), &specifier)
    .unwrap();
  js_sys::Reflect::set(
    &obj,
    &JsValue::from_str("mediaType"),
    &JsValue::from(media_type_to_u8(media_type)),
  )
  .unwrap();
  let code = Uint8Array::from(source);
  js_sys::Reflect::set(&obj, &JsValue::from_str("code"), &code).unwrap();
  obj.into()
}

fn create_external_repsonse(url: &Url) -> JsValue {
  let obj = Object::new();
  js_sys::Reflect::set(
    &obj,
    &JsValue::from_str("kind"),
    &JsValue::from_str("external"),
  )
  .unwrap();
  let specifier = JsValue::from_str(url.as_str());
  js_sys::Reflect::set(&obj, &JsValue::from_str("specifier"), &specifier)
    .unwrap();
  obj.into()
}

fn parse_entrypoint(
  entrypoint: String,
  cwd: &Path,
) -> Result<Url, anyhow::Error> {
  if entrypoint.starts_with("jsr:")
    || entrypoint.starts_with("https:")
    || entrypoint.starts_with("file:")
    || entrypoint.starts_with("npm:")
  {
    Ok(Url::parse(&entrypoint)?)
  } else {
    Ok(deno_path_util::url_from_file_path(&resolve_absolute_path(
      entrypoint, cwd,
    ))?)
  }
}

fn resolve_absolute_path(path: String, cwd: &Path) -> PathBuf {
  let path = sys_traits::impls::wasm_string_to_path(path);
  cwd.join(path)
}

fn create_js_error(err: anyhow::Error) -> JsValue {
  wasm_bindgen::JsError::new(&err.to_string()).into()
}

fn media_type_to_u8(media_type: MediaType) -> u8 {
  match media_type {
    MediaType::JavaScript => 0,
    MediaType::Jsx => 1,
    MediaType::Mjs => 2,
    MediaType::Cjs => 3,
    MediaType::TypeScript => 4,
    MediaType::Mts => 5,
    MediaType::Cts => 6,
    MediaType::Dts => 7,
    MediaType::Dmts => 8,
    MediaType::Dcts => 9,
    MediaType::Tsx => 10,
    MediaType::Css => 11,
    MediaType::Json => 12,
    MediaType::Html => 13,
    MediaType::Sql => 14,
    MediaType::Wasm => 15,
    MediaType::SourceMap => 16,
    MediaType::Unknown => 17,
  }
}

fn npm_system_info() -> Result<NpmSystemInfo, anyhow::Error> {
  PROCESS_GLOBAL.with(|process| {
    let os = js_sys::Reflect::get(process, &JsValue::from_str("platform"))
      .ok()
      .and_then(|s| s.as_string())
      .ok_or_else(|| {
        anyhow::anyhow!("Could not resolve process.platform global.")
      })?;
    let arch = js_sys::Reflect::get(process, &JsValue::from_str("arch"))
      .ok()
      .and_then(|s| s.as_string())
      .ok_or_else(|| {
        anyhow::anyhow!("Could not resolve process.arch global.")
      })?;
    Ok(NpmSystemInfo {
      os: SmallStackString::from_string(os),
      cpu: SmallStackString::from_string(arch),
    })
  })
}
