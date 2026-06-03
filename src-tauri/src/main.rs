#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Command, Child, Stdio};
use std::fs;
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};
use std::sync::Mutex;
use tauri::{Manager, AppHandle, Emitter};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::menu::{MenuBuilder, MenuItemBuilder};

/// Wrapper around the Node.js child process for thread-safe access.
struct NodeProcess(Mutex<Option<Child>>);

/// Close behavior: 0=direct close, 1=minimize to tray (default), 2=ask user
struct CloseBehavior(Mutex<u8>);

/// Try to read the UI port from the `.ui-port` file that ui-server writes.
fn try_read_port(port_file: &Path) -> Option<u16> {
    fs::read_to_string(port_file)
        .ok()
        .and_then(|s| s.trim().parse::<u16>().ok())
}

/// Get the temp port file path (ui-server writes here to avoid polluting install dir).
fn temp_port_file() -> std::path::PathBuf {
    std::env::temp_dir().join(".codex-assistant-ui-port")
}

/// Kill a process tree on Windows (the node process + all children).
fn kill_process_tree(child: &mut Child) {
    let pid = child.id();
    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}

/// Tauri command: get the current Node.js process status.
#[tauri::command]
fn get_node_status(state: tauri::State<NodeProcess>) -> bool {
    let mut guard = state.0.lock().unwrap();
    if let Some(ref mut child) = *guard {
        match child.try_wait() {
            Ok(Some(_)) => {
                *guard = None;
                false
            }
            _ => true,
        }
    } else {
        false
    }
}

/// Tauri command: set close behavior (0=close, 1=minimize to tray, 2=ask)
#[tauri::command]
fn set_close_behavior(behavior: u8, state: tauri::State<CloseBehavior>) {
    *state.0.lock().unwrap() = behavior;
}

/// Tauri command: minimize window to system tray
#[tauri::command]
fn minimize_to_tray(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

/// Tauri command: force close the application
#[tauri::command]
fn force_close(app: AppHandle, state: tauri::State<NodeProcess>) {
    // 清理 Node.js 进程
    let mut guard = state.0.lock().unwrap();
    if let Some(ref mut child) = *guard {
        kill_process_tree(child);
        *guard = None;
    }
    app.exit(0);
}

/// Tauri command: restart the Node.js process.
#[tauri::command]
fn restart_node(app: AppHandle, state: tauri::State<NodeProcess>) -> Result<(), String> {
    {
        let mut guard = state.0.lock().unwrap();
        if let Some(ref mut child) = *guard {
            kill_process_tree(child);
            *guard = None;
        }
    }

    let resource_dir = resolve_resource_dir(&app);
    let port_file = temp_port_file();
    let _ = fs::remove_file(&port_file);

    let child = spawn_node(&resource_dir)?;
    *state.0.lock().unwrap() = Some(child);

    let start = Instant::now();
    loop {
        if start.elapsed() > Duration::from_secs(45) {
            return Err("Timeout waiting for Node.js server restart".into());
        }
        if try_read_port(&port_file).is_some() {
            break;
        }
        thread::sleep(Duration::from_millis(200));
    }

    Ok(())
}

/// Resolve the resource directory, falling back to project root in dev mode.
fn resolve_resource_dir(app: &AppHandle) -> std::path::PathBuf {
    let resource_dir = app.path().resource_dir()
        .expect("Cannot resolve resource directory");
    // Check direct path first (dev mode / portable)
    if resource_dir.join("ui-server.mjs").exists() {
        return resource_dir;
    }
    // Check resources/ subdirectory (installed version)
    let sub = resource_dir.join("resources");
    if sub.join("ui-server.mjs").exists() {
        return sub;
    }
    // Dev mode: resource_dir is target/debug/, fall back to project root
    let cwd = std::env::current_dir().expect("Cannot get current directory");
    let project_root = cwd.parent().expect("Cannot get project root").to_path_buf();
    if project_root.join("ui-server.mjs").exists() {
        return project_root;
    }
    resource_dir
}

/// Spawn the Node.js ui-server process.
fn spawn_node(resource_dir: &Path) -> Result<Child, String> {
    // Prefer bundled node, fall back to system node
    let bundled_node = if cfg!(target_os = "windows") {
        resource_dir.join("node").join("node.exe")
    } else {
        resource_dir.join("node").join("node")
    };
    let node_cmd = if bundled_node.exists() {
        bundled_node
    } else {
        Path::new(if cfg!(target_os = "windows") { "node.exe" } else { "node" }).to_path_buf()
    };

    let ui_server_path = resource_dir.join("ui-server.mjs");
    if !ui_server_path.exists() {
        return Err(format!("ui-server.mjs not found at: {}", ui_server_path.display()));
    }

    // Use Stdio::null() to avoid pipe buffer deadlock.
    // Node.js writes logs to files via ui-server.mjs, so console output is not needed.
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let mut cmd = Command::new(node_cmd);
    cmd.arg(&ui_server_path)
        .current_dir(resource_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let child = cmd.spawn()
        .map_err(|e| format!("Failed to start Node.js: {}", e))?;

    Ok(child)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(NodeProcess(Mutex::new(None)))
        .manage(CloseBehavior(Mutex::new(1)))
        .setup(|app| {
            let resource_dir = resolve_resource_dir(app.handle());

            let port_file = temp_port_file();
            let _ = fs::remove_file(&port_file);

            let child = spawn_node(&resource_dir)?;
            // Mutate existing managed state instead of replacing it
            let state = app.state::<NodeProcess>();
            *state.0.lock().unwrap() = Some(child);

            let start = Instant::now();
            let port: u16 = loop {
                if start.elapsed() > Duration::from_secs(45) {
                    panic!("Timeout: Node.js UI server did not start within 45s.");
                }
                if let Some(p) = try_read_port(&port_file) {
                    break p;
                }
                thread::sleep(Duration::from_millis(300));
            };

            if let Some(window) = app.get_webview_window("main") {
                let url = format!("http://127.0.0.1:{}", port);
                // Use navigate() instead of eval() for safer URL injection
                let _ = window.navigate(url.parse().expect("Failed to parse URL"));
                window.show().expect("Failed to show window");
            }

            // Build system tray menu
            let show_item = MenuItemBuilder::with_id("show", "显示窗口").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&show_item, &quit_item]).build()?;

            // Build system tray icon
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("Codex Assistant")
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            // 清理 Node.js 进程后再退出
                            if let Some(window) = app.get_webview_window("main") {
                                let state = window.state::<NodeProcess>();
                                let mut guard = state.0.lock().unwrap();
                                if let Some(ref mut child) = *guard {
                                    kill_process_tree(child);
                                    *guard = None;
                                }
                            }
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::Destroyed => {
                    // Use AppHandle to access state (compatible with all Tauri v2 versions)
                    let state = window.state::<NodeProcess>();
                    let mut guard = state.0.lock().unwrap();
                    if let Some(ref mut child) = *guard {
                        kill_process_tree(child);
                        *guard = None;
                    }
                }
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    let behavior = window.state::<CloseBehavior>();
                    let b = *behavior.0.lock().unwrap();
                    match b {
                        0 => { /* direct close, do nothing */ }
                        1 => {
                            // Minimize to tray
                            let _ = api.prevent_close();
                            if let Some(window) = window.get_webview_window("main") {
                                let _ = window.hide();
                            }
                        }
                        2 => {
                            // Ask user — emit event to frontend
                            let _ = api.prevent_close();
                            if let Some(window) = window.get_webview_window("main") {
                                let _ = window.emit("close-requested", ());
                            }
                        }
                        _ => {
                            let _ = api.prevent_close();
                            if let Some(window) = window.get_webview_window("main") {
                                let _ = window.hide();
                            }
                        }
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![get_node_status, restart_node, set_close_behavior, minimize_to_tray, force_close])
        .run(tauri::generate_context!())
        .expect("error while running Codex Assistant");
}
