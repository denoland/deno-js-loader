mod http_client;

use std::borrow::Cow;
use std::cell::RefCell;
use std::error::Error;
use std::path::Path;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::OnceLock;

use anyhow::Context;
use anyhow::bail;
use deno_ast::ModuleKind;
use deno_cache_dir::file_fetcher::CacheSetting;
use deno_cache_dir::file_fetcher::NullBlobStore;
use deno_config::deno_json::NewestDependencyDate;
use deno_error::JsErrorBox;
use deno_graph::CheckJsOption;
use deno_graph::GraphKind;
use deno_graph::JsrMetadataStore;
use deno_graph::MediaType;
use deno_graph::ModuleGraph;
use deno_graph::Position;
use deno_graph::WalkOptions;
use deno_graph::analysis::ModuleAnalyzer;
use deno_graph::ast::CapturingEsParser;
use deno_graph::ast::DefaultEsParser;
use deno_graph::ast::EsParser;
use deno_graph::ast::ParsedSourceStore;
use deno_npm_installer::NpmInstallerFactory;
use deno_npm_installer::NpmInstallerFactoryOptions;
use deno_npm_installer::Reporter;
use deno_npm_installer::lifecycle_scripts::NullLifecycleScriptsExecutor;
use deno_resolver::DenoResolveError;
use deno_resolver::DenoResolveErrorKind;
use deno_resolver::cache::ParsedSourceCache;
use deno_resolver::cjs::CjsTrackerRc;
use deno_resolver::deno_json::CompilerOptionsOverrides;
use deno_resolver::deno_json::CompilerOptionsResolver;
use deno_resolver::deno_json::JsxImportSourceConfigResolver;
use deno_resolver::emit::Emitter;
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
use deno_resolver::graph::ResolveWithGraphError;
use deno_resolver::graph::ResolveWithGraphErrorKind;
use deno_resolver::graph::ResolveWithGraphOptions;
use deno_resolver::loader::AllowJsonImports;
use deno_resolver::loader::LoadCodeSourceErrorKind;
use deno_resolver::loader::LoadedModuleOrAsset;
use deno_resolver::loader::MemoryFilesRc;
use deno_resolver::loader::ModuleLoader;
use deno_resolver::loader::RequestedModuleType;
use deno_resolver::npm::DenoInNpmPackageChecker;
use deno_resolver::workspace::MappedResolutionError;
use deno_semver::SmallStackString;
use deno_semver::jsr::JsrPackageReqReference;
use deno_semver::npm::NpmPackageReqReference;
use js_sys::Object;
use js_sys::Uint8Array;
use log::LevelFilter;
use log::Metadata;
use log::Record;
use node_resolver::NodeConditionOptions;
use node_resolver::NodeResolverOptions;
use node_resolver::PackageJsonThreadLocalCache;
use node_resolver::analyze::NodeCodeTranslatorMode;
use node_resolver::cache::NodeResolutionThreadLocalCache;
use node_resolver::errors::NodeJsErrorCode;
use node_resolver::errors::NodeJsErrorCoded;
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

static GLOBAL_LOGGER: OnceLock<Logger> = OnceLock::new();

struct Logger {
  debug: bool,
}

impl log::Log for Logger {
  fn enabled(&self, metadata: &Metadata) -> bool {
    metadata.level() <= log::Level::Info
      || metadata.level() == log::Level::Debug && self.debug
  }

  fn log(&self, record: &Record) {
    if self.enabled(record.metadata()) {
      error(&JsValue::from(format!(
        "{} RS - {}",
        record.level(),
        record.args()
      )));
    }
  }

  fn flush(&self) {}
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
pub struct DenoWorkspaceOptions {
  // make all these optional to support someone providing `undefined`
  #[serde(default)]
  pub no_config: Option<bool>,
  #[serde(default)]
  pub no_lock: Option<bool>,
  #[serde(default)]
  pub platform: Option<String>,
  #[serde(default)]
  pub config_path: Option<String>,
  #[serde(default)]
  pub node_conditions: Option<Vec<String>>,
  #[serde(default)]
  pub newest_dependency_date: Option<chrono::DateTime<chrono::Utc>>,
  #[serde(default)]
  pub cached_only: Option<bool>,
  #[serde(default)]
  pub preserve_jsx: Option<bool>,
  #[serde(default)]
  pub no_transpile: Option<bool>,
  #[serde(default)]
  pub debug: Option<bool>,
}

#[wasm_bindgen]
pub struct DenoWorkspace {
  http_client: WasmHttpClient,
  npm_installer_factory:
    Rc<NpmInstallerFactory<WasmHttpClient, ConsoleLogReporter, RealSys>>,
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
        &anyhow::anyhow!("{}", err)
          .context("Failed deserializing workspace options."),
      )
    })?;
    Self::new_inner(options).map_err(|e| create_js_error(&e))
  }

  fn new_inner(options: DenoWorkspaceOptions) -> Result<Self, anyhow::Error> {
    fn resolve_is_browser_platform(
      options: &DenoWorkspaceOptions,
    ) -> Result<bool, anyhow::Error> {
      Ok(match options.platform.as_deref() {
        Some("node" | "deno") => false,
        Some("browser") => true,
        Some(value) => bail!("Unknown platform '{}'", value),
        None => false,
      })
    }

    let debug = options.debug.unwrap_or(false);
    let logger = GLOBAL_LOGGER.get_or_init(|| Logger { debug });
    _ = log::set_logger(logger).map(|()| {
      log::set_max_level(if debug {
        LevelFilter::Debug
      } else {
        LevelFilter::Info
      })
    });

    let sys = RealSys;
    let cwd = sys.env_current_dir()?;
    let is_browser_platform = resolve_is_browser_platform(&options)?;
    let config_discovery = if options.no_config.unwrap_or_default() {
      ConfigDiscoveryOption::Disabled
    } else if let Some(config_path) = options.config_path {
      ConfigDiscoveryOption::Path(
        resolve_absolute_path(config_path, &cwd)
          .context("Failed resolving config path.")?,
      )
    } else {
      ConfigDiscoveryOption::DiscoverCwd
    };
    let workspace_factory = Arc::new(WorkspaceFactory::new(
      sys.clone(),
      cwd,
      WorkspaceFactoryOptions {
        additional_config_file_names: &[],
        config_discovery,
        is_package_manager_subcommand: false,
        frozen_lockfile: None, // provide this via config
        lock_arg: None,        // supports the default only
        lockfile_skip_write: false,
        maybe_custom_deno_dir_root: None,
        node_modules_dir: None, // provide this via config
        no_lock: options.no_lock.unwrap_or_default(),
        no_npm: false,
        npm_process_state: None,
        root_node_modules_dir_override: None,
        vendor: None, // provide this via the config
      },
    ));
    let resolver_factory = Arc::new(ResolverFactory::new(
      workspace_factory.clone(),
      ResolverFactoryOptions {
        allow_json_imports: AllowJsonImports::Always,
        compiler_options_overrides: CompilerOptionsOverrides {
          no_transpile: options.no_transpile.unwrap_or(false),
          source_map_base: Some(
            workspace_factory
              .workspace_directory()?
              .workspace
              .root_dir_url()
              .as_ref()
              .clone(),
          ),
          preserve_jsx: options.preserve_jsx.unwrap_or(false),
        },
        // todo: make this configurable
        is_cjs_resolution_mode:
          deno_resolver::cjs::IsCjsResolutionMode::ExplicitTypeCommonJs,
        unstable_sloppy_imports: true,
        npm_system_info: npm_system_info()?,
        node_resolver_options: NodeResolverOptions {
          is_browser_platform,
          bundle_mode: true,
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
        node_analysis_cache: None,
        node_code_translator_mode: NodeCodeTranslatorMode::Disabled,
        node_resolution_cache: Some(Arc::new(NodeResolutionThreadLocalCache)),
        package_json_cache: Some(Arc::new(PackageJsonThreadLocalCache)),
        package_json_dep_resolution: None,
        require_modules: Vec::new(),
        specified_import_map: None,
        bare_node_builtins: true,
        newest_dependency_date: options
          .newest_dependency_date
          .map(NewestDependencyDate::Enabled),
        // todo: report these
        on_mapped_resolution_diagnostic: None,
        types_node_version_req: None,
      },
    ));
    let http_client = WasmHttpClient::default();
    let npm_installer_factory = Rc::new(NpmInstallerFactory::new(
      resolver_factory.clone(),
      Arc::new(http_client.clone()),
      Arc::new(NullLifecycleScriptsExecutor),
      ConsoleLogReporter,
      None,
      NpmInstallerFactoryOptions {
        cache_setting: if options.cached_only.unwrap_or_default() {
          deno_npm_cache::NpmCacheSetting::Only
        } else {
          deno_npm_cache::NpmCacheSetting::Use
        },
        caching_strategy: deno_npm_installer::graph::NpmCachingStrategy::Eager,
        lifecycle_scripts_config: deno_npm_installer::LifecycleScriptsConfig {
          allowed: deno_npm_installer::PackagesAllowedScripts::None,
          denied: Vec::new(),
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

  pub async fn create_loader(&self) -> Result<DenoLoader, JsValue> {
    self
      .create_loader_inner()
      .await
      .map_err(|e| create_js_error(&e))
  }

  async fn create_loader_inner(&self) -> Result<DenoLoader, anyhow::Error> {
    self
      .npm_installer_factory
      .initialize_npm_resolution_if_managed()
      .await?;
    let file_fetcher = Arc::new(PermissionedFileFetcher::new(
      NullBlobStore,
      Arc::new(self.workspace_factory.http_cache()?.clone()),
      self.http_client.clone(),
      MemoryFilesRc::default(),
      self.workspace_factory.sys().clone(),
      PermissionedFileFetcherOptions {
        allow_remote: true,
        cache_setting: CacheSetting::Use,
      },
    ));
    Ok(DenoLoader {
      cjs_tracker: self.resolver_factory.cjs_tracker()?.clone(),
      compiler_options_resolver: self
        .resolver_factory
        .compiler_options_resolver()?
        .clone(),
      file_fetcher,
      emitter: self.resolver_factory.emitter()?.clone(),
      resolver: self.resolver_factory.deno_resolver().await?.clone(),
      workspace_factory: self.workspace_factory.clone(),
      resolver_factory: self.resolver_factory.clone(),
      npm_installer_factory: self.npm_installer_factory.clone(),
      parsed_source_cache: self.resolver_factory.parsed_source_cache().clone(),
      module_loader: self.resolver_factory.module_loader()?.clone(),
      task_queue: Default::default(),
      graph: ModuleGraphCell::new(deno_graph::ModuleGraph::new(
        deno_graph::GraphKind::CodeOnly,
      )),
      jsr_metadata_store: Rc::new(JsrMetadataStore::default()),
    })
  }
}

#[wasm_bindgen]
pub struct DenoLoader {
  cjs_tracker: CjsTrackerRc<DenoInNpmPackageChecker, RealSys>,
  compiler_options_resolver: Arc<CompilerOptionsResolver>,
  resolver: DefaultDenoResolverRc<RealSys>,
  file_fetcher:
    Arc<PermissionedFileFetcher<NullBlobStore, RealSys, WasmHttpClient>>,
  emitter: Arc<Emitter<DenoInNpmPackageChecker, RealSys>>,
  npm_installer_factory:
    Rc<NpmInstallerFactory<WasmHttpClient, ConsoleLogReporter, RealSys>>,
  parsed_source_cache: Arc<ParsedSourceCache>,
  module_loader: Arc<ModuleLoader<RealSys>>,
  resolver_factory: Arc<ResolverFactory<RealSys>>,
  workspace_factory: Arc<WorkspaceFactory<RealSys>>,
  graph: ModuleGraphCell,
  task_queue: Rc<deno_unsync::TaskQueue>,
  jsr_metadata_store: Rc<JsrMetadataStore>,
}

impl Drop for DenoLoader {
  fn drop(&mut self) {
    NodeResolutionThreadLocalCache::clear();
  }
}

#[wasm_bindgen]
impl DenoLoader {
  pub fn get_graph(&self) -> JsValue {
    let serializer =
      serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
    self.graph.get().serialize(&serializer).unwrap()
  }

  pub async fn add_entrypoints(
    &self,
    entrypoints: Vec<String>,
  ) -> Result<Vec<String>, JsValue> {
    self
      .add_entrypoints_internal(entrypoints)
      .await
      .map_err(|e| create_js_error(&e))
  }

  async fn add_entrypoints_internal(
    &self,
    entrypoints: Vec<String>,
  ) -> Result<Vec<String>, anyhow::Error> {
    let urls = entrypoints
      .into_iter()
      .map(|e| {
        self.resolve_entrypoint(
          Cow::Owned(e),
          node_resolver::ResolutionMode::Import,
        )
      })
      .collect::<Result<Vec<_>, _>>()?;
    self.add_entrypoint_urls(urls.clone()).await?;
    let errors = self
      .graph
      .get()
      .walk(
        urls.iter(),
        WalkOptions {
          check_js: CheckJsOption::True,
          kind: GraphKind::CodeOnly,
          follow_dynamic: false,
          prefer_fast_check_graph: false,
        },
      )
      .errors()
      .map(|e| e.to_string_with_range())
      .collect();
    Ok(errors)
  }

  async fn add_entrypoint_urls(
    &self,
    entrypoints: Vec<Url>,
  ) -> Result<(), anyhow::Error> {
    // only allow one async task to modify the graph at a time
    let task_queue = self.task_queue.clone();
    task_queue
      .run(async {
        let npm_package_info_provider = self
          .npm_installer_factory
          .lockfile_npm_package_info_provider()?;
        let lockfile = self
          .workspace_factory
          .maybe_lockfile(npm_package_info_provider)
          .await?;
        let jsx_config =
          JsxImportSourceConfigResolver::from_compiler_options_resolver(
            &self.compiler_options_resolver,
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
            reporter: None,
          },
        );

        let mut locker = lockfile.as_ref().map(|l| l.as_deno_graph_locker());
        let npm_resolver =
          self.npm_installer_factory.npm_deno_graph_resolver().await?;
        let module_analyzer = CapturingModuleAnalyzerRef {
          store: self.parsed_source_cache.as_ref(),
          parser: &DefaultEsParser,
        };
        let mut graph = self.graph.deep_clone();
        if graph.roots.is_empty()
          && let Some(lockfile) = lockfile
        {
          lockfile.fill_graph(&mut graph);
        }
        let jsr_version_resolver =
          self.resolver_factory.jsr_version_resolver()?;
        graph
          .build(
            entrypoints,
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
              jsr_version_resolver: Cow::Borrowed(
                jsr_version_resolver.as_ref(),
              ),
              passthrough_jsr_specifiers: false,
              module_analyzer: &module_analyzer,
              npm_resolver: Some(npm_resolver.as_ref()),
              reporter: None,
              resolver: Some(&graph_resolver),
              unstable_bytes_imports: true,
              unstable_text_imports: true,
              jsr_metadata_store: Some(self.jsr_metadata_store.clone()),
            },
          )
          .await;
        self.graph.set(Rc::new(graph));
        Ok(())
      })
      .await
  }

  pub fn resolve_sync(
    &self,
    specifier: String,
    importer: Option<String>,
    resolution_mode: u8,
  ) -> Result<String, JsValue> {
    let importer = self
      .resolve_provided_referrer(importer)
      .map_err(|e| create_js_error(&e))?;
    self
      .resolve_sync_inner(
        &specifier,
        importer.as_ref(),
        parse_resolution_mode(resolution_mode),
      )
      .map_err(|err| {
        self.create_resolve_js_error(&err, &specifier, importer.as_ref())
      })
  }

  fn resolve_sync_inner(
    &self,
    specifier: &str,
    importer: Option<&Url>,
    resolution_mode: node_resolver::ResolutionMode,
  ) -> Result<String, anyhow::Error> {
    let (specifier, referrer) = self.resolve_specifier_and_referrer(
      specifier,
      importer,
      resolution_mode,
    )?;
    let resolved = self.resolver.resolve_with_graph(
      &self.graph.get(),
      &specifier,
      &referrer,
      deno_graph::Position::zeroed(),
      ResolveWithGraphOptions {
        mode: resolution_mode,
        kind: node_resolver::NodeResolutionKind::Execution,
        maintain_npm_specifiers: false,
      },
    )?;
    Ok(resolved.into())
  }

  pub async fn resolve(
    &self,
    specifier: String,
    importer: Option<String>,
    resolution_mode: u8,
  ) -> Result<String, JsValue> {
    let importer = self
      .resolve_provided_referrer(importer)
      .map_err(|e| create_js_error(&e))?;
    self
      .resolve_inner(
        &specifier,
        importer.as_ref(),
        parse_resolution_mode(resolution_mode),
      )
      .await
      .map_err(|err| {
        self.create_resolve_js_error(&err, &specifier, importer.as_ref())
      })
  }

  async fn resolve_inner(
    &self,
    specifier: &str,
    importer: Option<&Url>,
    resolution_mode: node_resolver::ResolutionMode,
  ) -> Result<String, anyhow::Error> {
    let (specifier, referrer) = self.resolve_specifier_and_referrer(
      specifier,
      importer,
      resolution_mode,
    )?;
    let resolved = self.resolver.resolve_with_graph(
      &self.graph.get(),
      &specifier,
      &referrer,
      deno_graph::Position::zeroed(),
      ResolveWithGraphOptions {
        mode: resolution_mode,
        kind: node_resolver::NodeResolutionKind::Execution,
        maintain_npm_specifiers: true,
      },
    )?;
    if NpmPackageReqReference::from_specifier(&resolved).is_ok()
      || JsrPackageReqReference::from_specifier(&resolved).is_ok()
    {
      self.add_entrypoint_urls(vec![resolved.clone()]).await?;
      self.resolve_sync_inner(&specifier, importer, resolution_mode)
    } else {
      Ok(resolved.into())
    }
  }

  fn resolve_specifier_and_referrer<'a>(
    &self,
    specifier: &'a str,
    referrer: Option<&'a Url>,
    resolution_mode: node_resolver::ResolutionMode,
  ) -> Result<(Cow<'a, str>, Cow<'a, Url>), anyhow::Error> {
    Ok(match referrer {
      Some(referrer) => (Cow::Borrowed(specifier), Cow::Borrowed(referrer)),
      None => {
        let entrypoint = Cow::Owned(
          self
            .resolve_entrypoint(Cow::Borrowed(specifier), resolution_mode)?
            .into(),
        );
        (
          entrypoint,
          Cow::Owned(deno_path_util::url_from_directory_path(
            self.workspace_factory.initial_cwd(),
          )?),
        )
      }
    })
  }

  fn resolve_provided_referrer(
    &self,
    importer: Option<String>,
  ) -> Result<Option<Url>, anyhow::Error> {
    let importer = importer.filter(|v| !v.is_empty());
    Ok(match importer {
      Some(referrer)
        if referrer.starts_with("http:")
          || referrer.starts_with("https:")
          || referrer.starts_with("file:") =>
      {
        Some(Url::parse(&referrer)?)
      }
      Some(referrer) => Some(deno_path_util::url_from_file_path(
        &sys_traits::impls::wasm_string_to_path(referrer),
      )?),
      None => None,
    })
  }

  pub async fn load(
    &self,
    url: String,
    requested_module_type: u8,
  ) -> Result<JsValue, JsValue> {
    let requested_module_type = match requested_module_type {
      0 => RequestedModuleType::None,
      1 => RequestedModuleType::Json,
      2 => RequestedModuleType::Text,
      3 => RequestedModuleType::Bytes,
      _ => {
        return Err(create_js_error(&anyhow::anyhow!(
          "Invalid requested module type: {}",
          requested_module_type
        )));
      }
    };
    self
      .load_inner(url, &requested_module_type)
      .await
      .map_err(|err| create_js_error(&err))
  }

  async fn load_inner(
    &self,
    url: String,
    requested_module_type: &RequestedModuleType<'_>,
  ) -> Result<JsValue, anyhow::Error> {
    let url = Url::parse(&url)?;

    if url.scheme() == "node" {
      return Ok(create_external_repsonse(&url));
    } else if url.scheme() == "jsr" {
      bail!(
        "Failed loading '{}'. jsr: specifiers must be resolved to an https: specifier before being loaded.",
        url
      );
    }

    match self
      .module_loader
      .load(&self.graph.get(), &url, None, requested_module_type)
      .await
    {
      Ok(LoadedModuleOrAsset::Module(m)) => {
        self.parsed_source_cache.free(&m.specifier);
        Ok(create_module_response(
          &m.specifier,
          m.media_type,
          m.source.as_bytes(),
        ))
      }
      Ok(LoadedModuleOrAsset::ExternalAsset {
        specifier,
        statically_analyzable: _,
      }) => {
        let file = self
          .file_fetcher
          .fetch_bypass_permissions(&specifier)
          .await?;
        let media_type = MediaType::from_specifier_and_headers(
          &file.url,
          file.maybe_headers.as_ref(),
        );
        Ok(create_module_response(&file.url, media_type, &file.source))
      }
      Err(err) => match err.as_kind() {
        LoadCodeSourceErrorKind::LoadUnpreparedModule(_) => {
          if url.scheme() == "npm" {
            bail!(
              "Failed resolving '{}'\n\nResolve the npm: specifier to a file: specifier before providing it to the loader.",
              url
            )
          }
          let file = self.file_fetcher.fetch_bypass_permissions(&url).await?;
          let media_type = MediaType::from_specifier_and_headers(
            &url,
            file.maybe_headers.as_ref(),
          );
          match requested_module_type {
            RequestedModuleType::Text | RequestedModuleType::Bytes => {
              Ok(create_module_response(&file.url, media_type, &file.source))
            }
            RequestedModuleType::Json
            | RequestedModuleType::None
            | RequestedModuleType::Other(_) => {
              if media_type.is_emittable() {
                let str = String::from_utf8_lossy(&file.source);
                let value = str.into();
                let source = self
                  .maybe_transpile(&file.url, media_type, &value, None)
                  .await?;
                Ok(create_module_response(
                  &file.url,
                  media_type,
                  source.as_bytes(),
                ))
              } else {
                Ok(create_module_response(&file.url, media_type, &file.source))
              }
            }
          }
        }
        _ => Err(err.into()),
      },
    }
  }

  async fn maybe_transpile(
    &self,
    specifier: &Url,
    media_type: MediaType,
    source: &Arc<str>,
    is_known_script: Option<bool>,
  ) -> Result<Arc<str>, anyhow::Error> {
    let parsed_source = self.parsed_source_cache.get_matching_parsed_source(
      specifier,
      media_type,
      source.clone(),
    )?;
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
    let module_kind = ModuleKind::from_is_cjs(is_cjs);
    let source = self
      .emitter
      .maybe_emit_parsed_source(parsed_source, module_kind)
      .await?;
    Ok(source)
  }

  fn resolve_entrypoint(
    &self,
    specifier: Cow<str>,
    resolution_mode: node_resolver::ResolutionMode,
  ) -> Result<Url, anyhow::Error> {
    let cwd = self.workspace_factory.initial_cwd();
    if specifier.contains('\\') {
      return Ok(deno_path_util::url_from_file_path(&resolve_absolute_path(
        specifier.into_owned(),
        cwd,
      )?)?);
    }
    let referrer = deno_path_util::url_from_directory_path(cwd)?;
    Ok(self.resolver.resolve(
      &specifier,
      &referrer,
      Position::zeroed(),
      resolution_mode,
      node_resolver::NodeResolutionKind::Execution,
    )?)
  }

  fn is_optional_npm_dep(&self, specifier: &str, referrer: &Url) -> bool {
    let Ok(referrer_path) = deno_path_util::url_to_file_path(referrer) else {
      return false;
    };
    for result in self
      .resolver_factory
      .pkg_json_resolver()
      .get_closest_package_jsons(&referrer_path)
    {
      let Ok(pkg_json) = result else {
        continue;
      };
      if let Some(optional_deps) = &pkg_json.optional_dependencies
        && optional_deps.contains_key(specifier)
      {
        return true;
      }
      if let Some(meta) = &pkg_json.peer_dependencies_meta
        && let Some(obj) = meta.get(specifier)
        && let Some(value) = obj.get("optional")
        && let Some(is_optional) = value.as_bool()
        && is_optional
      {
        return true;
      }
      if let Some(deps) = &pkg_json.dependencies
        && deps.contains_key(specifier)
      {
        return false;
      }
      if let Some(deps) = &pkg_json.peer_dependencies
        && deps.contains_key(specifier)
      {
        return false;
      }
    }
    false
  }

  fn create_resolve_js_error(
    &self,
    err: &anyhow::Error,
    specifier: &str,
    maybe_referrer: Option<&Url>,
  ) -> JsValue {
    let err_value = create_js_error(err);
    if let Some(err) = err.downcast_ref::<ResolveWithGraphError>() {
      if let Some(code) = resolve_with_graph_error_code(err) {
        _ = js_sys::Reflect::set(
          &err_value,
          &JsValue::from_str("code"),
          &JsValue::from_str(code.as_str()),
        );
        if code == NodeJsErrorCode::ERR_MODULE_NOT_FOUND
          && let Some(referrer) = maybe_referrer
          && self.is_optional_npm_dep(specifier, referrer)
        {
          _ = js_sys::Reflect::set(
            &err_value,
            &JsValue::from_str("isOptionalDependency"),
            &JsValue::from_bool(true),
          );
        }
      }
      if let Some(specifier) = err.maybe_specifier()
        && let Ok(url) = specifier.into_owned().into_url()
      {
        _ = js_sys::Reflect::set(
          &err_value,
          &JsValue::from_str("specifier"),
          &JsValue::from_str(url.as_str()),
        );
      }
    }
    err_value
  }
}

fn resolve_with_graph_error_code(
  err: &ResolveWithGraphError,
) -> Option<NodeJsErrorCode> {
  match err.as_kind() {
    ResolveWithGraphErrorKind::CouldNotResolveNpmReqRef(err) => {
      Some(err.code())
    }
    ResolveWithGraphErrorKind::ManagedResolvePkgFolderFromDenoReq(_) => None,
    ResolveWithGraphErrorKind::ResolvePkgFolderFromDenoModule(_) => None,
    ResolveWithGraphErrorKind::ResolveNpmReqRef(err) => err.err.maybe_code(),
    ResolveWithGraphErrorKind::Resolution(err) => err
      .source()
      .and_then(|s| s.downcast_ref::<DenoResolveError>())
      .and_then(deno_resolve_error_code),
    ResolveWithGraphErrorKind::Resolve(err) => deno_resolve_error_code(err),
    ResolveWithGraphErrorKind::PathToUrl(_) => None,
  }
}

fn deno_resolve_error_code(err: &DenoResolveError) -> Option<NodeJsErrorCode> {
  match err.as_kind() {
    DenoResolveErrorKind::InvalidVendorFolderImport
    | DenoResolveErrorKind::UnsupportedPackageJsonFileSpecifier
    | DenoResolveErrorKind::UnsupportedPackageJsonJsrReq => None,
    DenoResolveErrorKind::MappedResolution(err) => match err {
      MappedResolutionError::Specifier(_)
      | MappedResolutionError::ImportMap(_)
      | MappedResolutionError::Workspace(_)
      | MappedResolutionError::NotFoundInCompilerOptionsPaths(_) => None,
    },
    DenoResolveErrorKind::Node(err) => err.maybe_code(),
    DenoResolveErrorKind::ResolveNpmReqRef(err) => err.err.maybe_code(),
    DenoResolveErrorKind::NodeModulesOutOfDate(_)
    | DenoResolveErrorKind::PackageJsonDepValueParse(_)
    | DenoResolveErrorKind::PackageJsonDepValueUrlParse(_)
    | DenoResolveErrorKind::PathToUrl(_)
    | DenoResolveErrorKind::ResolvePkgFolderFromDenoReq(_)
    | DenoResolveErrorKind::WorkspaceResolvePkgJsonFolder(_) => None,
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

fn resolve_absolute_path(
  path: String,
  cwd: &Path,
) -> Result<PathBuf, anyhow::Error> {
  if path.starts_with("file:///") {
    let url = Url::parse(&path)?;
    Ok(deno_path_util::url_to_file_path(&url)?)
  } else {
    let path = sys_traits::impls::wasm_string_to_path(path);
    Ok(cwd.join(path))
  }
}

fn create_js_error(err: &anyhow::Error) -> JsValue {
  wasm_bindgen::JsError::new(&format!("{:#}", err)).into()
}

fn parse_resolution_mode(resolution_mode: u8) -> node_resolver::ResolutionMode {
  match resolution_mode {
    1 => node_resolver::ResolutionMode::Require,
    _ => node_resolver::ResolutionMode::Import,
  }
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
    MediaType::Jsonc => 13,
    MediaType::Json5 => 14,
    MediaType::Html => 15,
    MediaType::Sql => 16,
    MediaType::Wasm => 17,
    MediaType::SourceMap => 18,
    MediaType::Unknown => 19,
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

struct ModuleGraphCell {
  graph: RefCell<Rc<ModuleGraph>>,
}

impl ModuleGraphCell {
  pub fn new(graph: ModuleGraph) -> Self {
    Self {
      graph: RefCell::new(Rc::new(graph)),
    }
  }

  pub fn deep_clone(&self) -> ModuleGraph {
    self.graph.borrow().as_ref().clone()
  }

  pub fn get(&self) -> Rc<ModuleGraph> {
    self.graph.borrow().clone()
  }

  pub fn set(&self, graph: Rc<ModuleGraph>) {
    *self.graph.borrow_mut() = graph;
  }
}

// todo(dsherret): shift this down into deno_graph
struct CapturingModuleAnalyzerRef<'a> {
  parser: &'a dyn EsParser,
  store: &'a dyn ParsedSourceStore,
}

impl<'a> CapturingModuleAnalyzerRef<'a> {
  pub fn as_capturing_parser(&self) -> CapturingEsParser<'_> {
    CapturingEsParser::new(Some(self.parser), self.store)
  }
}

#[async_trait::async_trait(?Send)]
impl ModuleAnalyzer for CapturingModuleAnalyzerRef<'_> {
  async fn analyze(
    &self,
    specifier: &deno_ast::ModuleSpecifier,
    source: Arc<str>,
    media_type: MediaType,
  ) -> Result<deno_graph::analysis::ModuleInfo, JsErrorBox> {
    let capturing_parser = self.as_capturing_parser();
    let module_analyzer =
      deno_graph::ast::ParserModuleAnalyzer::new(&capturing_parser);
    module_analyzer.analyze(specifier, source, media_type).await
  }
}
