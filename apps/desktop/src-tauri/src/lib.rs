use std::{
    io,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::Arc,
};

use karazhan_core::application::{Application, share_application};
use karazhan_http_adapter::HttpAdapter;
use karazhan_tauri_adapter::{MacOsZedLauncher, TauriAdapter};
use tauri::Manager;

pub const PRODUCT_NAME: &str = "Karazhan";
pub const BUNDLE_IDENTIFIER: &str = "com.jiayi.karazhan";
pub const DATABASE_FILENAME: &str = "karazhan.sqlite3";
pub const HTTP_API_PORT: u16 = 47_831;

pub fn database_path(app_data_directory: &Path) -> PathBuf {
    app_data_directory.join(DATABASE_FILENAME)
}

pub fn trusted_workspace_roots(app_data_directory: &Path, home_directory: &Path) -> Vec<PathBuf> {
    vec![
        home_directory.to_path_buf(),
        app_data_directory.join("workspaces"),
    ]
}

pub fn run() {
    let builder = karazhan_tauri_adapter::with_ipc_handler(tauri::Builder::default());
    builder
        .setup(|app| {
            let app_data_directory = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_directory)?;

            let managed_workspace_root = app_data_directory.join("workspaces");
            std::fs::create_dir_all(&managed_workspace_root)?;
            let home_directory = app.path().home_dir()?;

            let application =
                share_application(Application::open(database_path(&app_data_directory))?);
            let tauri_adapter = TauriAdapter::from_shared(application.clone())
                .with_zed(
                    trusted_workspace_roots(&app_data_directory, &home_directory),
                    Arc::new(MacOsZedLauncher),
                )
                .map_err(|error| io::Error::other(error.message))?;
            app.manage(tauri_adapter);

            let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), HTTP_API_PORT);
            let http_adapter = HttpAdapter::from_shared(application, address)?;
            tauri::async_runtime::spawn(async move {
                if let Err(error) = http_adapter.serve().await {
                    eprintln!("Karazhan HTTP adapter stopped: {error}");
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Karazhan desktop runtime failed");
}
