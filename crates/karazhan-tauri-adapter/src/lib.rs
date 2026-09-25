//! Thin Tauri IPC adapter for the shared Karazhan application contract.

use std::{
    io,
    path::{Path, PathBuf},
    process::Command as ProcessCommand,
    sync::Arc,
};

use karazhan_core::{
    DomainError,
    application::{
        Application, Command, CommandResult, Query, QueryResult, SharedApplication,
        share_application,
    },
};
use serde::Serialize;

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct AdapterError {
    pub code: &'static str,
    pub message: String,
}

impl From<DomainError> for AdapterError {
    fn from(error: DomainError) -> Self {
        Self {
            code: error.code(),
            message: error.to_string(),
        }
    }
}

pub struct TauriAdapter {
    application: SharedApplication,
    zed: Option<ZedConfiguration>,
}

impl TauriAdapter {
    pub fn new(application: Application) -> Self {
        Self {
            application: share_application(application),
            zed: None,
        }
    }

    pub fn from_shared(application: SharedApplication) -> Self {
        Self {
            application,
            zed: None,
        }
    }

    pub fn with_zed(
        mut self,
        trusted_roots: Vec<PathBuf>,
        launcher: Arc<dyn WorkspaceLauncher>,
    ) -> Result<Self, AdapterError> {
        if trusted_roots.is_empty() {
            return Err(adapter_error(
                "invalid_trusted_root",
                "at least one trusted Workspace root is required",
            ));
        }
        let mut canonical_roots = Vec::with_capacity(trusted_roots.len());
        for root in trusted_roots {
            let canonical = root.canonicalize().map_err(|_| {
                adapter_error(
                    "invalid_trusted_root",
                    "a trusted Workspace root does not exist",
                )
            })?;
            if !canonical.is_dir() {
                return Err(adapter_error(
                    "invalid_trusted_root",
                    "a trusted Workspace root is not a directory",
                ));
            }
            canonical_roots.push(canonical);
        }
        self.zed = Some(ZedConfiguration {
            trusted_roots: canonical_roots,
            launcher,
        });
        Ok(self)
    }

    pub fn execute(&self, command: Command) -> Result<CommandResult, AdapterError> {
        self.application
            .lock()
            .map_err(|_| unavailable())?
            .execute(command)
            .map_err(AdapterError::from)
    }

    pub fn query(&self, query: Query) -> Result<QueryResult, AdapterError> {
        self.application
            .lock()
            .map_err(|_| unavailable())?
            .query(query)
            .map_err(AdapterError::from)
    }

    pub fn open_in_zed(&self, node_id: &str) -> Result<(), AdapterError> {
        let configuration = self.zed.as_ref().ok_or_else(|| {
            adapter_error(
                "zed_not_configured",
                "Open in Zed is not configured for this application",
            )
        })?;
        let QueryResult::ResourceBindings(bindings) = self.query(Query::ListResourceBindings {
            node_id: node_id.into(),
        })?
        else {
            unreachable!("resource binding query returned another result type");
        };
        let binding = bindings
            .iter()
            .find(|binding| binding.kind == "workspace" && binding.is_primary)
            .ok_or_else(|| {
                adapter_error(
                    "workspace_missing",
                    "the selected node has no primary Workspace binding",
                )
            })?;
        let workspace = PathBuf::from(&binding.locator)
            .canonicalize()
            .map_err(|_| {
                adapter_error(
                    "workspace_path_missing",
                    "the bound Workspace path does not exist",
                )
            })?;
        if !workspace.is_dir() {
            return Err(adapter_error(
                "workspace_not_directory",
                "the bound Workspace path is not a directory",
            ));
        }
        if !configuration
            .trusted_roots
            .iter()
            .any(|root| workspace.starts_with(root))
        {
            return Err(adapter_error(
                "untrusted_workspace",
                "the bound Workspace is outside every trusted root",
            ));
        }
        configuration
            .launcher
            .open_in_zed(&workspace)
            .map_err(|error| {
                adapter_error(
                    "zed_launch_failed",
                    format!("Launch Services could not open Zed: {error}"),
                )
            })
    }
}

struct ZedConfiguration {
    trusted_roots: Vec<PathBuf>,
    launcher: Arc<dyn WorkspaceLauncher>,
}

pub trait WorkspaceLauncher: Send + Sync {
    fn open_in_zed(&self, path: &Path) -> io::Result<()>;
}

pub struct MacOsZedLauncher;

impl WorkspaceLauncher for MacOsZedLauncher {
    fn open_in_zed(&self, path: &Path) -> io::Result<()> {
        let status = ProcessCommand::new("/usr/bin/open")
            .arg("-a")
            .arg("Zed")
            .arg(path)
            .status()?;
        if status.success() {
            Ok(())
        } else {
            Err(io::Error::other(format!(
                "Launch Services exited with {status}"
            )))
        }
    }
}

fn adapter_error(code: &'static str, message: impl Into<String>) -> AdapterError {
    AdapterError {
        code,
        message: message.into(),
    }
}

fn unavailable() -> AdapterError {
    adapter_error(
        "adapter_unavailable",
        "Tauri application state is unavailable",
    )
}

#[tauri::command]
fn execute_command(
    state: tauri::State<'_, TauriAdapter>,
    command: Command,
) -> Result<CommandResult, AdapterError> {
    state.execute(command)
}

#[tauri::command]
fn run_query(
    state: tauri::State<'_, TauriAdapter>,
    query: Query,
) -> Result<QueryResult, AdapterError> {
    state.query(query)
}

#[tauri::command]
fn open_in_zed(state: tauri::State<'_, TauriAdapter>, node_id: String) -> Result<(), AdapterError> {
    state.open_in_zed(&node_id)
}

pub fn with_ipc_handler<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.invoke_handler(tauri::generate_handler![
        execute_command,
        run_query,
        open_in_zed
    ])
}
