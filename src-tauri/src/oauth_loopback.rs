use serde::Serialize;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::State;

const LOOPBACK_TIMEOUT_SECS: u64 = 180;
const MAX_REQUEST_BYTES: usize = 16 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthLoopbackStartResult {
    pub port: u16,
    pub redirect_uri: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthLoopbackCallback {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

struct LoopbackSession {
    callback: Option<OAuthLoopbackCallback>,
    generation: u64,
    cancelled: Arc<AtomicBool>,
}

#[derive(Clone, Default)]
pub struct OAuthLoopbackState {
    session: Arc<Mutex<Option<LoopbackSession>>>,
}

fn parse_query_value(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        let mut parts = pair.splitn(2, '=');
        let name = parts.next()?;
        if name == key {
            let value = parts.next().unwrap_or("");
            return Some(
                urlencoding::decode(value)
                    .map(|decoded| decoded.into_owned())
                    .unwrap_or_else(|_| value.to_string()),
            );
        }
    }
    None
}

fn read_request_path(stream: &mut TcpStream) -> Option<String> {
    let mut buffer = [0_u8; MAX_REQUEST_BYTES];
    let read = stream.read(&mut buffer).ok()?;
    let request = String::from_utf8_lossy(&buffer[..read]);
    let first_line = request.lines().next()?;
    let mut parts = first_line.split_whitespace();
    let method = parts.next()?;
    let target = parts.next()?;
    if method != "GET" {
        return None;
    }
    Some(target.to_string())
}

fn write_callback_response(stream: &mut TcpStream, success: bool) {
    let title = if success {
        "Connexion réussie"
    } else {
        "Connexion échouée"
    };
    let body = format!(
        "<!DOCTYPE html><html lang=\"fr\"><head><meta charset=\"utf-8\"><title>{title}</title></head><body><p>{title}. Vous pouvez fermer cette fenêtre et revenir à TrackDidia.</p></body></html>"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
}

fn handle_connection(mut stream: TcpStream, expected_state: String) -> OAuthLoopbackCallback {
    let target = read_request_path(&mut stream).unwrap_or_else(|| "/".to_string());
    let path_and_query = target.split_once('?').map(|(_, query)| query).unwrap_or("");
    let code = parse_query_value(path_and_query, "code");
    let state = parse_query_value(path_and_query, "state");
    let error = parse_query_value(path_and_query, "error");
    let error_description = parse_query_value(path_and_query, "error_description");

    let success =
        error.is_none() && code.is_some() && state.as_deref() == Some(expected_state.as_str());
    write_callback_response(&mut stream, success);

    OAuthLoopbackCallback {
        code,
        state,
        error,
        error_description,
    }
}

#[tauri::command]
pub fn oauth_loopback_start(
    state: State<'_, OAuthLoopbackState>,
    expected_state: String,
) -> Result<OAuthLoopbackStartResult, String> {
    if expected_state.trim().is_empty() {
        return Err("expected_state required".to_string());
    }

    let cancelled = Arc::new(AtomicBool::new(false));
    let generation = {
        let mut session = state
            .session
            .lock()
            .map_err(|_| "Loopback state lock poisoned".to_string())?;
        if let Some(active) = session.as_ref() {
            active.cancelled.store(true, Ordering::SeqCst);
        }
        let next_generation = session.as_ref().map(|active| active.generation + 1).unwrap_or(1);
        *session = Some(LoopbackSession {
            callback: None,
            generation: next_generation,
            cancelled: cancelled.clone(),
        });
        next_generation
    };

    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("Loopback bind failed: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Loopback nonblocking failed: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("Loopback local_addr failed: {error}"))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/oauth/callback");

    let state_handle = state.inner().clone();
    let expected = expected_state.clone();
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(LOOPBACK_TIMEOUT_SECS);
        while Instant::now() < deadline {
            if cancelled.load(Ordering::SeqCst) {
                return;
            }
            match listener.accept() {
                Ok((stream, _)) => {
                    let callback = handle_connection(stream, expected.clone());
                    if cancelled.load(Ordering::SeqCst) {
                        return;
                    }
                    if let Ok(mut session) = state_handle.session.lock() {
                        if let Some(active) = session.as_mut() {
                            if active.generation == generation {
                                active.callback = Some(callback);
                            }
                        }
                    }
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(50));
                }
                Err(_) => break,
            }
        }
    });

    Ok(OAuthLoopbackStartResult { port, redirect_uri })
}

#[tauri::command]
pub async fn oauth_loopback_wait(
    state: State<'_, OAuthLoopbackState>,
    timeout_ms: u32,
) -> Result<OAuthLoopbackCallback, String> {
    let timeout = Duration::from_millis(timeout_ms.clamp(1_000, 180_000) as u64);
    let started = Instant::now();

    loop {
        let callback = {
            let session = state
                .session
                .lock()
                .map_err(|_| "Loopback state lock poisoned".to_string())?;
            session.as_ref().and_then(|active| active.callback.clone())
        };
        if let Some(result) = callback {
            if let Ok(mut session) = state.session.lock() {
                *session = None;
            }
            return Ok(result);
        }
        if started.elapsed() >= timeout {
            if let Ok(mut session) = state.session.lock() {
                *session = None;
            }
            return Err("oauth_loopback_timeout".to_string());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
