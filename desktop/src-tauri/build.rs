fn main() {
    // Declare the app's own #[tauri::command]s so tauri-build generates
    // allow-<command> / deny-<command> ACL permissions for them. Without this,
    // the app has no ACL manifest and invoking these commands from the remote
    // sidecar origin (http://127.0.0.1:*) is rejected with "Plugin not found".
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::default()
                .commands(&["app_version", "check_for_updates", "download_and_install_update"]),
        ),
    )
    .expect("failed to run tauri-build");
}
