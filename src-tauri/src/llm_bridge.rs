//! Local MCP endpoint for LLM clients (disabled unless the user turns it on in Settings).
//!
//! This module is a thin, authenticated transport. It speaks MCP "Streamable HTTP" (JSON
//! responses only) on `127.0.0.1`, answers `initialize`/`ping` itself, and forwards
//! `tools/list` and `tools/call` to the webview as a `llm-bridge-request` event. All task logic
//! lives in TypeScript (`src/lib/llm-bridge/`) because the repository, lifecycle events and
//! statistics are there; the webview answers through [`llm_bridge_respond`].
//!
//! Security model: loopback bind only, a random bearer token compared in constant time, a `Host`
//! allow-list (DNS-rebinding defence), and any request carrying an `Origin` header (a browser) is
//! refused. The token and request bodies are never logged.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Semaphore};

const REQUEST_EVENT: &str = "llm-bridge-request";
const MCP_PATH: &str = "/mcp";
const MAX_HEAD_BYTES: usize = 16 * 1024;
const MAX_BODY_BYTES: usize = 256 * 1024;
const MIN_TOKEN_LEN: usize = 32;
const MAX_CONNECTIONS: usize = 16;
const READ_TIMEOUT: Duration = Duration::from_secs(10);
const FORWARD_TIMEOUT: Duration = Duration::from_secs(25);
const LATEST_PROTOCOL: &str = "2025-06-18";
const SUPPORTED_PROTOCOLS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INSTRUCTIONS: &str = "TrackDidia is the user's local-first GTD app. Tasks you add \
land in the Inbox by default so the user can clarify them later. Call list_projects and \
list_contexts before attaching tasks to a project or context. The desktop app must be running.";

#[derive(Debug, Clone)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

impl RpcError {
    fn new(code: i64, message: &str) -> Self {
        Self {
            code,
            message: message.to_string(),
        }
    }

    fn to_value(&self) -> Value {
        json!({ "code": self.code, "message": self.message })
    }
}

type ForwardResult = Result<Value, RpcError>;
type ForwardFuture = Pin<Box<dyn Future<Output = ForwardResult> + Send>>;
/// `(method, params)` -> the webview's answer.
type Forwarder = Arc<dyn Fn(String, Value) -> ForwardFuture + Send + Sync>;
type PendingMap = Arc<Mutex<HashMap<String, oneshot::Sender<ForwardResult>>>>;

struct ServerConfig {
    port: u16,
    token: String,
    forward: Forwarder,
}

#[derive(Debug)]
struct HttpError {
    status: u16,
    message: &'static str,
    www_authenticate: bool,
}

impl HttpError {
    fn new(status: u16, message: &'static str) -> Self {
        Self {
            status,
            message,
            www_authenticate: false,
        }
    }
}

struct HttpHead {
    method: String,
    path: String,
    headers: HashMap<String, String>,
}

struct HttpResponse {
    status: u16,
    body: Vec<u8>,
    extra_headers: Vec<(&'static str, &'static str)>,
}

impl HttpResponse {
    fn json(status: u16, value: &Value) -> Self {
        Self {
            status,
            body: value.to_string().into_bytes(),
            extra_headers: Vec::new(),
        }
    }

    fn empty(status: u16) -> Self {
        Self {
            status,
            body: Vec::new(),
            extra_headers: Vec::new(),
        }
    }

    fn from_error(error: &HttpError) -> Self {
        let mut response = Self::json(error.status, &json!({ "error": error.message }));
        if error.www_authenticate {
            response.extra_headers.push(("WWW-Authenticate", "Bearer"));
        }
        response
    }

    fn into_bytes(self) -> Vec<u8> {
        let reason = match self.status {
            200 => "OK",
            202 => "Accepted",
            400 => "Bad Request",
            401 => "Unauthorized",
            403 => "Forbidden",
            404 => "Not Found",
            405 => "Method Not Allowed",
            408 => "Request Timeout",
            411 => "Length Required",
            413 => "Payload Too Large",
            431 => "Request Header Fields Too Large",
            501 => "Not Implemented",
            _ => "Error",
        };
        let mut head = format!("HTTP/1.1 {} {}\r\n", self.status, reason);
        if !self.body.is_empty() {
            head.push_str("Content-Type: application/json\r\n");
        }
        head.push_str(&format!("Content-Length: {}\r\n", self.body.len()));
        head.push_str("Cache-Control: no-store\r\nConnection: close\r\n");
        for (name, value) in self.extra_headers {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        head.push_str("\r\n");
        let mut bytes = head.into_bytes();
        bytes.extend_from_slice(&self.body);
        bytes
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let mut diff = a.len() ^ b.len();
    for index in 0..a.len().max(b.len()) {
        let x = a.get(index).copied().unwrap_or(0);
        let y = b.get(index).copied().unwrap_or(0);
        diff |= usize::from(x ^ y);
    }
    diff == 0
}

fn find_head_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn parse_head(head: &str) -> Result<HttpHead, HttpError> {
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split(' ');
    let (Some(method), Some(target), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(HttpError::new(400, "malformed request line"));
    };
    if !version.starts_with("HTTP/1.") {
        return Err(HttpError::new(400, "unsupported HTTP version"));
    }
    let mut headers = HashMap::new();
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return Err(HttpError::new(400, "malformed header"));
        };
        headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
    }
    Ok(HttpHead {
        method: method.to_string(),
        path: target.split('?').next().unwrap_or_default().to_string(),
        headers,
    })
}

fn authorize(head: &HttpHead, port: u16, token: &str) -> Result<(), HttpError> {
    let host = head
        .headers
        .get("host")
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    if host != format!("127.0.0.1:{port}") && host != format!("localhost:{port}") {
        return Err(HttpError::new(403, "host not allowed"));
    }
    // Browsers always send Origin on cross-site requests; MCP clients never do.
    if head.headers.contains_key("origin") {
        return Err(HttpError::new(403, "browser origins are not allowed"));
    }
    let presented = head
        .headers
        .get("authorization")
        .and_then(|value| {
            let (scheme, credentials) = value.split_once(' ')?;
            scheme
                .eq_ignore_ascii_case("bearer")
                .then_some(credentials.trim())
        })
        .unwrap_or_default();
    if token.is_empty() || !constant_time_eq(presented.as_bytes(), token.as_bytes()) {
        let mut error = HttpError::new(401, "missing or invalid bearer token");
        error.www_authenticate = true;
        return Err(error);
    }
    Ok(())
}

async fn read_head(stream: &mut TcpStream) -> Result<(HttpHead, Vec<u8>), HttpError> {
    let mut buffer: Vec<u8> = Vec::with_capacity(2048);
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(position) = find_head_end(&buffer) {
            break position;
        }
        if buffer.len() > MAX_HEAD_BYTES {
            return Err(HttpError::new(431, "request headers too large"));
        }
        let read = stream
            .read(&mut chunk)
            .await
            .map_err(|_| HttpError::new(400, "unreadable request"))?;
        if read == 0 {
            return Err(HttpError::new(400, "connection closed early"));
        }
        buffer.extend_from_slice(&chunk[..read]);
    };
    let head_text = std::str::from_utf8(&buffer[..head_end])
        .map_err(|_| HttpError::new(400, "headers are not UTF-8"))?;
    let head = parse_head(head_text)?;
    let leftover = buffer[head_end + 4..].to_vec();
    Ok((head, leftover))
}

async fn read_body(
    stream: &mut TcpStream,
    head: &HttpHead,
    mut body: Vec<u8>,
) -> Result<Vec<u8>, HttpError> {
    if head.headers.contains_key("transfer-encoding") {
        return Err(HttpError::new(501, "chunked bodies are not supported"));
    }
    let length: usize = head
        .headers
        .get("content-length")
        .ok_or_else(|| HttpError::new(411, "content-length required"))?
        .parse()
        .map_err(|_| HttpError::new(400, "invalid content-length"))?;
    if length > MAX_BODY_BYTES {
        return Err(HttpError::new(413, "body too large"));
    }
    if body.len() < length
        && head
            .headers
            .get("expect")
            .is_some_and(|value| value.eq_ignore_ascii_case("100-continue"))
    {
        let _ = stream.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").await;
    }
    let mut chunk = [0u8; 4096];
    while body.len() < length {
        let read = stream
            .read(&mut chunk)
            .await
            .map_err(|_| HttpError::new(400, "unreadable body"))?;
        if read == 0 {
            return Err(HttpError::new(400, "body ended early"));
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(length);
    Ok(body)
}

fn rpc_response(id: &Value, outcome: ForwardResult) -> HttpResponse {
    let payload = match outcome {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": error.to_value() }),
    };
    HttpResponse::json(200, &payload)
}

fn negotiate_protocol(params: &Value) -> &'static str {
    let requested = params.get("protocolVersion").and_then(Value::as_str);
    SUPPORTED_PROTOCOLS
        .iter()
        .find(|supported| Some(**supported) == requested)
        .copied()
        .unwrap_or(LATEST_PROTOCOL)
}

async fn handle_rpc(body: &[u8], config: &ServerConfig) -> HttpResponse {
    let Ok(message) = serde_json::from_slice::<Value>(body) else {
        return rpc_response(&Value::Null, Err(RpcError::new(-32700, "Parse error")));
    };
    let Some(object) = message.as_object() else {
        return rpc_response(
            &Value::Null,
            Err(RpcError::new(
                -32600,
                "Expected a single JSON-RPC request object",
            )),
        );
    };
    let Some(method) = object.get("method").and_then(Value::as_str) else {
        // A JSON-RPC response sent by the client: nothing to answer.
        return HttpResponse::empty(202);
    };
    let Some(id) = object.get("id") else {
        // Notification (e.g. notifications/initialized).
        return HttpResponse::empty(202);
    };
    let params = object.get("params").cloned().unwrap_or(Value::Null);

    let outcome = match method {
        "initialize" => Ok(json!({
            "protocolVersion": negotiate_protocol(&params),
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": "trackdidia", "version": env!("CARGO_PKG_VERSION") },
            "instructions": SERVER_INSTRUCTIONS,
        })),
        "ping" => Ok(json!({})),
        "tools/list" | "tools/call" => (config.forward)(method.to_string(), params).await,
        _ => Err(RpcError::new(-32601, "Method not found")),
    };
    rpc_response(id, outcome)
}

async fn route(stream: &mut TcpStream, config: &ServerConfig) -> HttpResponse {
    // Reads are bounded here; waiting on the webview is bounded separately by FORWARD_TIMEOUT.
    let timed_out = || HttpResponse::from_error(&HttpError::new(408, "request timed out"));
    let (head, leftover) = match tokio::time::timeout(READ_TIMEOUT, read_head(stream)).await {
        Ok(Ok(parts)) => parts,
        Ok(Err(error)) => return HttpResponse::from_error(&error),
        Err(_) => return timed_out(),
    };
    if let Err(error) = authorize(&head, config.port, &config.token) {
        return HttpResponse::from_error(&error);
    }
    if head.path != MCP_PATH {
        return HttpResponse::from_error(&HttpError::new(404, "not found"));
    }
    if head.method != "POST" {
        let mut response = HttpResponse::from_error(&HttpError::new(405, "use POST"));
        response.extra_headers.push(("Allow", "POST"));
        return response;
    }
    match tokio::time::timeout(READ_TIMEOUT, read_body(stream, &head, leftover)).await {
        Ok(Ok(body)) => handle_rpc(&body, config).await,
        Ok(Err(error)) => HttpResponse::from_error(&error),
        Err(_) => timed_out(),
    }
}

async fn handle_connection(mut stream: TcpStream, config: Arc<ServerConfig>) {
    let response = route(&mut stream, &config).await;
    let _ = stream.write_all(&response.into_bytes()).await;
    let _ = stream.shutdown().await;
}

/// Connection tasks live in a `JoinSet` owned by this loop, so aborting the loop (stop, disable,
/// token or port change) also aborts every connection it accepted. Without that, a socket opened
/// before a token rotation could finish its request afterwards and still authenticate with the
/// revoked token.
async fn accept_loop(listener: TcpListener, config: Arc<ServerConfig>) {
    let permits = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let mut connections = tokio::task::JoinSet::new();
    loop {
        let Ok((stream, peer)) = listener.accept().await else {
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        };
        // Reap finished connections so the set does not grow for the life of the server.
        while connections.try_join_next().is_some() {}
        if !peer.ip().is_loopback() {
            continue;
        }
        let Ok(permit) = permits.clone().try_acquire_owned() else {
            continue;
        };
        let config = config.clone();
        connections.spawn(async move {
            let _permit = permit;
            handle_connection(stream, config).await;
        });
    }
}

struct RunningServer {
    task: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Default)]
pub struct LlmBridgeState {
    server: tokio::sync::Mutex<Option<RunningServer>>,
    pending: PendingMap,
    next_request_id: Arc<AtomicU64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmBridgeStatus {
    running: bool,
    port: Option<u16>,
}

fn build_forwarder(app: AppHandle, pending: PendingMap, counter: Arc<AtomicU64>) -> Forwarder {
    Arc::new(move |method, params| {
        let app = app.clone();
        let pending = pending.clone();
        let id = format!("llm-{}", counter.fetch_add(1, Ordering::Relaxed));
        Box::pin(async move {
            let (sender, receiver) = oneshot::channel();
            if let Ok(mut map) = pending.lock() {
                map.insert(id.clone(), sender);
            }
            let payload = json!({ "id": id, "method": method, "params": params });
            if app.emit(REQUEST_EVENT, payload).is_err() {
                if let Ok(mut map) = pending.lock() {
                    map.remove(&id);
                }
                return Err(RpcError::new(-32000, "TrackDidia window is not available"));
            }
            match tokio::time::timeout(FORWARD_TIMEOUT, receiver).await {
                Ok(Ok(outcome)) => outcome,
                Ok(Err(_)) => Err(RpcError::new(-32000, "TrackDidia bridge stopped")),
                Err(_) => {
                    if let Ok(mut map) = pending.lock() {
                        map.remove(&id);
                    }
                    Err(RpcError::new(-32000, "TrackDidia did not answer in time"))
                }
            }
        })
    })
}

#[tauri::command]
pub async fn llm_bridge_configure(
    app: AppHandle,
    state: State<'_, LlmBridgeState>,
    enabled: bool,
    port: u16,
    token: String,
) -> Result<LlmBridgeStatus, String> {
    // Holding the lock for the whole call serializes start/stop requests.
    let mut server = state.server.lock().await;
    if let Some(running) = server.take() {
        running.task.abort();
        // Wait for the listener to be dropped so the port can be bound again right away.
        let _ = running.task.await;
    }
    if let Ok(mut map) = state.pending.lock() {
        map.clear();
    }
    if !enabled {
        return Ok(LlmBridgeStatus {
            running: false,
            port: None,
        });
    }
    if token.len() < MIN_TOKEN_LEN {
        return Err("Le jeton MCP est trop court.".to_string());
    }
    if port < 1024 {
        return Err("Le port MCP doit etre superieur ou egal a 1024.".to_string());
    }
    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|error| format!("Impossible d'ouvrir 127.0.0.1:{port}: {error}"))?;
    let config = Arc::new(ServerConfig {
        port,
        token,
        forward: build_forwarder(app, state.pending.clone(), state.next_request_id.clone()),
    });
    let task = tauri::async_runtime::spawn(accept_loop(listener, config));
    *server = Some(RunningServer { task });
    Ok(LlmBridgeStatus {
        running: true,
        port: Some(port),
    })
}

#[derive(Deserialize)]
pub struct LlmBridgeRpcError {
    code: i64,
    message: String,
}

#[tauri::command]
pub fn llm_bridge_respond(
    state: State<'_, LlmBridgeState>,
    id: String,
    result: Option<Value>,
    error: Option<LlmBridgeRpcError>,
) {
    let sender = state
        .pending
        .lock()
        .ok()
        .and_then(|mut map| map.remove(&id));
    if let Some(sender) = sender {
        let outcome = match error {
            Some(error) => Err(RpcError {
                code: error.code,
                message: error.message,
            }),
            None => Ok(result.unwrap_or(Value::Null)),
        };
        let _ = sender.send(outcome);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";

    fn head(headers: &[(&str, &str)]) -> HttpHead {
        HttpHead {
            method: "POST".to_string(),
            path: MCP_PATH.to_string(),
            headers: headers
                .iter()
                .map(|(name, value)| (name.to_string(), value.to_string()))
                .collect(),
        }
    }

    #[test]
    fn constant_time_eq_compares_content_and_length() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(!constant_time_eq(b"", b"a"));
    }

    #[test]
    fn parse_head_lowercases_headers_and_drops_the_query() {
        let parsed = parse_head("POST /mcp?x=1 HTTP/1.1\r\nHost: 127.0.0.1:1\r\nX-A:  b ").unwrap();
        assert_eq!(parsed.method, "POST");
        assert_eq!(parsed.path, "/mcp");
        assert_eq!(parsed.headers.get("x-a").map(String::as_str), Some("b"));
        assert!(parse_head("GARBAGE\r\n").is_err());
        assert!(parse_head("POST /mcp HTTP/1.1\r\nno-colon").is_err());
    }

    #[test]
    fn authorize_requires_host_no_origin_and_the_exact_token() {
        let bearer = format!("Bearer {TOKEN}");
        let ok = head(&[("host", "127.0.0.1:4000"), ("authorization", &bearer)]);
        assert!(authorize(&ok, 4000, TOKEN).is_ok());

        let localhost = head(&[("host", "LocalHost:4000"), ("authorization", &bearer)]);
        assert!(authorize(&localhost, 4000, TOKEN).is_ok());

        let rebinding = head(&[("host", "evil.example:4000"), ("authorization", &bearer)]);
        assert_eq!(authorize(&rebinding, 4000, TOKEN).unwrap_err().status, 403);

        let browser = head(&[
            ("host", "127.0.0.1:4000"),
            ("origin", "https://evil.example"),
            ("authorization", &bearer),
        ]);
        assert_eq!(authorize(&browser, 4000, TOKEN).unwrap_err().status, 403);

        let wrong = head(&[("host", "127.0.0.1:4000"), ("authorization", "Bearer nope")]);
        assert_eq!(authorize(&wrong, 4000, TOKEN).unwrap_err().status, 401);

        let missing = head(&[("host", "127.0.0.1:4000")]);
        assert_eq!(authorize(&missing, 4000, TOKEN).unwrap_err().status, 401);

        // An empty configured token must never authenticate an empty credential.
        let empty = head(&[("host", "127.0.0.1:4000"), ("authorization", "Bearer ")]);
        assert_eq!(authorize(&empty, 4000, "").unwrap_err().status, 401);
    }

    #[test]
    fn negotiates_a_supported_protocol_version() {
        assert_eq!(
            negotiate_protocol(&json!({ "protocolVersion": "2024-11-05" })),
            "2024-11-05"
        );
        assert_eq!(
            negotiate_protocol(&json!({ "protocolVersion": "1999" })),
            LATEST_PROTOCOL
        );
        assert_eq!(negotiate_protocol(&Value::Null), LATEST_PROTOCOL);
    }

    fn echo_forwarder() -> Forwarder {
        Arc::new(|method, params| {
            Box::pin(async move {
                if method == "tools/call" && params.get("name") == Some(&json!("boom")) {
                    return Err(RpcError::new(-32602, "Unknown tool: boom"));
                }
                Ok(json!({ "method": method, "params": params }))
            })
        })
    }

    async fn start_test_server() -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let config = Arc::new(ServerConfig {
            port,
            token: TOKEN.to_string(),
            forward: echo_forwarder(),
        });
        tokio::spawn(accept_loop(listener, config));
        port
    }

    async fn send(port: u16, request: String) -> (u16, Value) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await.unwrap();
        let text = String::from_utf8(raw).unwrap();
        let status: u16 = text.split(' ').nth(1).unwrap().parse().unwrap();
        let body = text.split("\r\n\r\n").nth(1).unwrap_or_default();
        (status, serde_json::from_str(body).unwrap_or(Value::Null))
    }

    fn post(port: u16, extra: &str, body: &str) -> String {
        format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: {}\r\n{extra}\r\n{body}",
            body.len()
        )
    }

    fn authed(port: u16, body: &str) -> String {
        post(port, &format!("Authorization: Bearer {TOKEN}\r\n"), body)
    }

    #[tokio::test]
    async fn rejects_unauthenticated_requests_before_reading_a_body() {
        let port = start_test_server().await;
        let (status, _) = send(port, post(port, "", "{}")).await;
        assert_eq!(status, 401);
        let wrong = post(port, "Authorization: Bearer wrong\r\n", "{}");
        assert_eq!(send(port, wrong).await.0, 401);
    }

    #[tokio::test]
    async fn answers_initialize_and_ping_locally() {
        let port = start_test_server().await;
        let init = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}"#;
        let (status, body) = send(port, authed(port, init)).await;
        assert_eq!(status, 200);
        assert_eq!(body["id"], json!(1));
        assert_eq!(body["result"]["protocolVersion"], json!("2025-03-26"));
        assert_eq!(body["result"]["serverInfo"]["name"], json!("trackdidia"));

        let ping = r#"{"jsonrpc":"2.0","id":"p","method":"ping"}"#;
        let (_, body) = send(port, authed(port, ping)).await;
        assert_eq!(body["id"], json!("p"));
        assert_eq!(body["result"], json!({}));
    }

    #[tokio::test]
    async fn forwards_tool_methods_and_maps_errors() {
        let port = start_test_server().await;
        let list = r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#;
        let (_, body) = send(port, authed(port, list)).await;
        assert_eq!(body["result"]["method"], json!("tools/list"));

        let boom = r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"boom"}}"#;
        let (status, body) = send(port, authed(port, boom)).await;
        assert_eq!(status, 200);
        assert_eq!(body["error"]["code"], json!(-32602));
    }

    #[tokio::test]
    async fn handles_notifications_batches_and_unknown_methods() {
        let port = start_test_server().await;
        let note = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
        assert_eq!(send(port, authed(port, note)).await.0, 202);

        let batch = r#"[{"jsonrpc":"2.0","id":1,"method":"ping"}]"#;
        let (_, body) = send(port, authed(port, batch)).await;
        assert_eq!(body["error"]["code"], json!(-32600));

        let unknown = r#"{"jsonrpc":"2.0","id":9,"method":"resources/list"}"#;
        let (_, body) = send(port, authed(port, unknown)).await;
        assert_eq!(body["error"]["code"], json!(-32601));

        let (_, body) = send(port, authed(port, "not json")).await;
        assert_eq!(body["error"]["code"], json!(-32700));
    }

    #[tokio::test]
    async fn enforces_method_path_and_size_limits() {
        let port = start_test_server().await;
        let get = format!(
            "GET /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {TOKEN}\r\n\r\n"
        );
        assert_eq!(send(port, get).await.0, 405);

        let elsewhere = format!(
            "POST /other HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {TOKEN}\r\nContent-Length: 2\r\n\r\n{{}}"
        );
        assert_eq!(send(port, elsewhere).await.0, 404);

        let huge = format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {TOKEN}\r\nContent-Length: {}\r\n\r\n",
            MAX_BODY_BYTES + 1
        );
        assert_eq!(send(port, huge).await.0, 413);

        let no_length = format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {TOKEN}\r\n\r\n"
        );
        assert_eq!(send(port, no_length).await.0, 411);
    }

    #[tokio::test]
    async fn stopping_the_server_cuts_connections_opened_before_rotation() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let config = Arc::new(ServerConfig {
            port,
            token: TOKEN.to_string(),
            forward: echo_forwarder(),
        });
        let server = tokio::spawn(accept_loop(listener, config));

        // A client opens a connection and stalls mid-headers, as a revoked-token holder could.
        let mut stalled = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stalled.write_all(b"POST /mcp HTTP/1.1\r\n").await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;

        // Token rotation / disable aborts the accept loop and waits for it, like the command does.
        server.abort();
        let _ = server.await;

        // The old token is now revoked: finishing the request must not get an answer.
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#;
        let rest = format!(
            "Host: 127.0.0.1:{port}\r\nAuthorization: Bearer {TOKEN}\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let _ = stalled.write_all(rest.as_bytes()).await;
        let mut raw = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(2), stalled.read_to_end(&mut raw)).await;
        assert!(raw.is_empty(), "revoked connection was still answered");
    }

    #[tokio::test]
    async fn refuses_browser_origins_even_with_a_valid_token() {
        let port = start_test_server().await;
        let request = post(
            port,
            &format!("Authorization: Bearer {TOKEN}\r\nOrigin: https://evil.example\r\n"),
            r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#,
        );
        assert_eq!(send(port, request).await.0, 403);
    }
}
