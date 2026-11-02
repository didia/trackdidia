use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State};

const TRAY_ID: &str = "desktop-tray";
/// Emitted to the webview when the tray's Quit is chosen while the webview has asked to publish first.
const QUIT_REQUESTED_EVENT: &str = "desktop-quit-requested";
/// How long the host waits for the webview to answer with `desktop_exit` before it exits anyway. A bit
/// above the 3 s cap of the webview's own last publish (SYNC_QUIT_PUBLISH_CAP_MS), so a stuck or
/// missing webview can never keep the app from quitting.
const QUIT_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(4);

pub struct DesktopShellState {
    pub run_in_tray: Mutex<bool>,
    /// True while the webview listens for `QUIT_REQUESTED_EVENT` and promises to call `desktop_exit`.
    pub exit_handshake: AtomicBool,
    /// True once a tray Quit is waiting for that answer.
    pub exit_pending: AtomicBool,
}

impl Default for DesktopShellState {
    fn default() -> Self {
        Self {
            run_in_tray: Mutex::new(false),
            exit_handshake: AtomicBool::new(false),
            exit_pending: AtomicBool::new(false),
        }
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Exits the app from the main thread (the tray menu already runs there; the timer thread does not).
fn exit_app(app: &AppHandle) {
    let handle = app.clone();
    if app.run_on_main_thread(move || handle.exit(0)).is_err() {
        app.exit(0);
    }
}

/// The tray's Quit. Without the handshake the app exits at once, as it always did. With it, the webview
/// is asked to publish first (event) and answers with `desktop_exit`; a timer exits anyway if it never
/// does. A second Quit while one is waiting exits at once.
fn request_quit(app: &AppHandle) {
    let state = app.state::<DesktopShellState>();
    let handshake = state.exit_handshake.load(Ordering::SeqCst);
    let already_pending = state.exit_pending.swap(true, Ordering::SeqCst);
    if !handshake || already_pending || app.emit(QUIT_REQUESTED_EVENT, ()).is_err() {
        exit_app(app);
        return;
    }
    let app_handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(QUIT_HANDSHAKE_TIMEOUT);
        exit_app(&app_handle);
    });
}

fn build_tray(app: &AppHandle) -> Result<(), String> {
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }
    let show_item = MenuItem::with_id(app, "show", "Afficher", true, None::<&str>)
        .map_err(|error| format!("Impossible de creer le menu Afficher: {error}"))?;
    let quit_item = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)
        .map_err(|error| format!("Impossible de creer le menu Quitter: {error}"))?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])
        .map_err(|error| format!("Impossible de creer le menu barre systeme: {error}"))?;
    let icon = app
        .default_window_icon()
        .ok_or_else(|| "Icone application introuvable".to_string())?
        .clone();
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|error| format!("Impossible de creer la barre systeme: {error}"))?;
    Ok(())
}

fn remove_tray(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_visible(false);
    }
    let _ = app.remove_tray_by_id(TRAY_ID);
}

pub fn sync_tray_visibility(app: &AppHandle, run_in_tray: bool) -> Result<(), String> {
    if run_in_tray {
        build_tray(app)?;
        if let Some(tray) = app.tray_by_id(TRAY_ID) {
            let _ = tray.set_visible(true);
        }
    } else {
        remove_tray(app);
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_set_run_in_tray(
    app: AppHandle,
    state: State<DesktopShellState>,
    run_in_tray: bool,
) -> Result<(), String> {
    if run_in_tray {
        sync_tray_visibility(&app, true)?;
        *state
            .run_in_tray
            .lock()
            .map_err(|_| "Etat bureau verrouille".to_string())? = true;
    } else {
        *state
            .run_in_tray
            .lock()
            .map_err(|_| "Etat bureau verrouille".to_string())? = false;
        sync_tray_visibility(&app, false)?;
    }
    Ok(())
}

/// The webview calls this when it starts listening for `QUIT_REQUESTED_EVENT` (sync automation on) and
/// when it stops. While false the tray's Quit exits immediately.
#[tauri::command]
pub fn desktop_set_exit_handshake(state: State<DesktopShellState>, enabled: bool) {
    state.exit_handshake.store(enabled, Ordering::SeqCst);
}

/// The webview's answer to `QUIT_REQUESTED_EVENT`, after its last publish. Safe to call repeatedly.
#[tauri::command]
pub fn desktop_exit(app: AppHandle) {
    exit_app(&app);
}

pub fn register_close_handler(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let app_handle = app.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let run_in_tray = *app_handle
                    .state::<DesktopShellState>()
                    .run_in_tray
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if run_in_tray {
                    api.prevent_close();
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.hide();
                    }
                }
            }
        });
    }
}
