use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State};

const TRAY_ID: &str = "email-triage-tray";

pub struct EmailTriageDesktopState {
    pub run_in_tray: Mutex<bool>,
}

impl Default for EmailTriageDesktopState {
    fn default() -> Self {
        Self {
            run_in_tray: Mutex::new(false),
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
            "quit" => app.exit(0),
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
pub fn email_triage_set_desktop_prefs(
    app: AppHandle,
    state: State<EmailTriageDesktopState>,
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

pub fn register_close_handler(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let app_handle = app.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let run_in_tray = *app_handle
                    .state::<EmailTriageDesktopState>()
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
