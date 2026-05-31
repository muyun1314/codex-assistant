use std::process::{Command, Child, Stdio};
use std::fs;
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};
use std::sync::Mutex;
use tauri::{Manager, AppHandle};

/// Wrapper around the Node.js child process for thread-safe access.
struct NodeProcess(Mutex<Option<Child>>);

/// Try to read the UI port from the `.ui-port` file that ui-server writes.
fn try_read_port(port_file: &Path) -> Option<u16> {
    fs::read_to_string(port_file)
        .ok()
        .and_then(|s| s.trim().parse::<u16>().ok())
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
    let port_file = resource_dir.join(".ui-port");
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
    if resource_dir.join("ui-server.mjs").exists() {
        resource_dir
    } else {
        // Dev mode: resource_dir is target/debug/, fall back to project root
        std::env::current_dir().expect("Cannot get current directory")
            .parent().expect("Cannot get project root").to_path_buf()
    }
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
    let child = Command::new(node_cmd)
        .arg(&ui_server_path)
        .current_dir(resource_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start Node.js: {}", e))?;

    Ok(child)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(NodeProcess(Mutex::new(None)))
        .setup(|app| {
            let resource_dir = resolve_resource_dir(app.handle());

            let port_file = resource_dir.join(".ui-port");
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

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // Use AppHandle to access state (compatible with all Tauri v2 versions)
                let state = window.state::<NodeProcess>();
                let mut guard = state.0.lock().unwrap();
                if let Some(ref mut child) = *guard {
                    kill_process_tree(child);
                    *guard = None;
                }
            }
        })
        .invoke_handler(tauri::generate_handler![get_node_status, restart_node])
        .run(tauri::generate_context!())
        .expect("error while running Codex Assistant");
}
