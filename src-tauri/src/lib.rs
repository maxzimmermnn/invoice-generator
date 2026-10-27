// Desktop shell for the single-file invoice generator. All application logic
// stays in the web bundle; the shell only adds what a browser tab can't do:
// native save dialogs (src/main.js → downloadBlob) and self-updates from the
// GitHub Releases feed (src/main.js → "Desktop app" section).

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
