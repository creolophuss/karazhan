use std::path::Path;

use karazhan_desktop::{
    BUNDLE_IDENTIFIER, DATABASE_FILENAME, PRODUCT_NAME, database_path, trusted_workspace_roots,
};

#[test]
fn product_identity_and_development_command_are_frozen() {
    let tauri_config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let workspace_package: serde_json::Value =
        serde_json::from_str(include_str!("../../../../package.json")).unwrap();

    assert_eq!(PRODUCT_NAME, "Karazhan");
    assert_eq!(BUNDLE_IDENTIFIER, "com.jiayi.karazhan");
    assert_eq!(tauri_config["productName"], PRODUCT_NAME);
    assert_eq!(tauri_config["identifier"], BUNDLE_IDENTIFIER);
    assert_eq!(
        workspace_package["scripts"]["desktop:dev"],
        "npm --workspace @karazhan/desktop run tauri dev"
    );
    assert_eq!(
        workspace_package["scripts"]["desktop:build"],
        "sh ./scripts/build-desktop.sh"
    );
    let desktop_build = include_str!("../../../../scripts/build-desktop.sh");
    assert!(desktop_build.contains("target/release/bundle/macos/Karazhan.app"));
    assert!(desktop_build.contains("build --no-bundle"));
}

#[test]
fn open_in_zed_trusts_the_user_home_and_managed_workspace_root() {
    let app_data_directory =
        Path::new("/Users/test/Library/Application Support/com.jiayi.karazhan");
    let home_directory = Path::new("/Users/test");

    assert_eq!(
        trusted_workspace_roots(app_data_directory, home_directory),
        vec![
            home_directory.to_path_buf(),
            app_data_directory.join("workspaces")
        ]
    );
}

#[test]
fn database_lives_below_the_tauri_application_data_directory() {
    let app_data_directory =
        Path::new("/Users/test/Library/Application Support/com.jiayi.karazhan");

    assert_eq!(
        database_path(app_data_directory),
        app_data_directory.join(DATABASE_FILENAME)
    );
}
