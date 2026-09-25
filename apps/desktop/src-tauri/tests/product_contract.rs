use std::path::Path;

use karazhan_desktop::{BUNDLE_IDENTIFIER, DATABASE_FILENAME, PRODUCT_NAME, database_path};

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
