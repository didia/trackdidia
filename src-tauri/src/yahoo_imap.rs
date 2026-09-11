use imap::Session;
use imap_proto::types::Capability;
use mailparse::MailHeaderMap;
use native_tls::TlsConnector;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

type ImapSession = Session<native_tls::TlsStream<TcpStream>>;
type ImapCapabilities = imap::types::Capabilities;

const IMAP_HOST: &str = "imap.mail.yahoo.com";
const IMAP_PORT: u16 = 993;
const COMMAND_TIMEOUT_SECS: u64 = 20;
const MAX_BODY_BYTES: usize = 64 * 1024;
const MAX_TOTAL_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone)]
struct YahooCredentials {
    email: String,
    app_password: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YahooImapDiscoverResponse {
    pub delimiter: String,
    pub inbox_name: String,
    pub namespace_prefix: Option<String>,
    pub uidvalidity: u32,
    pub highest_uid: u32,
    pub supports_move: bool,
    pub supports_uidplus: bool,
    pub supports_uid_expunge: bool,
    pub capabilities: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YahooImapFetchInboxResponse {
    pub messages: Vec<YahooImapMessageResponse>,
    pub uidvalidity: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YahooImapMessageResponse {
    pub uid: u32,
    pub message_id: Option<String>,
    pub references: Vec<String>,
    pub in_reply_to: Option<String>,
    pub subject: String,
    pub from: String,
    pub to: Vec<String>,
    pub received_at: String,
    pub body_text: String,
    pub oversized: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YahooImapUidActionResponse {
    pub destination_uid: Option<u32>,
    pub destination_mailbox: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YahooImapFetchInboxRequest {
    pub email: String,
    pub app_password: String,
    pub after_uid: u32,
    pub limit: u32,
    pub inbox_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YahooImapSearchMessageIdRequest {
    pub email: String,
    pub app_password: String,
    pub message_id: String,
    pub inbox_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YahooImapEnsureMailboxRequest {
    pub email: String,
    pub app_password: String,
    pub mailbox_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YahooImapUidMailboxRequest {
    pub email: String,
    pub app_password: String,
    pub uid: u32,
    pub mailbox_name: String,
    pub inbox_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YahooImapFetchUidMessageIdRequest {
    pub email: String,
    pub app_password: String,
    pub uid: u32,
    pub inbox_name: Option<String>,
}

fn sanitize_error(message: String, secret: &str) -> String {
    let mut sanitized = message;
    if !secret.is_empty() {
        sanitized = sanitized.replace(secret, "***");
    }
    sanitized
        .lines()
        .map(str::trim)
        .filter(|line| {
            let lower = line.to_ascii_lowercase();
            !lower.contains("password") && !lower.contains("auth")
        })
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(400)
        .collect()
}

fn escape_imap_quoted_string(value: &str) -> Result<String, String> {
    if value.contains('\r') || value.contains('\n') {
        return Err("invalid_imap_string".to_string());
    }
    Ok(value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn quote_mailbox(name: &str) -> Result<String, String> {
    if name.contains(' ') || name.contains('"') || name.contains('\\') {
        Ok(format!("\"{}\"", escape_imap_quoted_string(name)?))
    } else {
        Ok(name.to_string())
    }
}

fn connect_session(credentials: &YahooCredentials) -> Result<ImapSession, String> {
    let timeout = Duration::from_secs(COMMAND_TIMEOUT_SECS);
    let tls = TlsConnector::builder()
        .build()
        .map_err(|error| sanitize_error(format!("TLS setup failed: {error}"), &credentials.app_password))?;
    let tcp = connect_tcp(&credentials.app_password, timeout)?;
    tcp.set_read_timeout(Some(timeout)).map_err(|error| {
        sanitize_error(format!("TCP read timeout failed: {error}"), &credentials.app_password)
    })?;
    tcp.set_write_timeout(Some(timeout)).map_err(|error| {
        sanitize_error(format!("TCP write timeout failed: {error}"), &credentials.app_password)
    })?;
    let tls_stream = tls.connect(IMAP_HOST, tcp).map_err(|error| {
        sanitize_error(format!("TLS handshake failed: {error}"), &credentials.app_password)
    })?;
    let client = imap::Client::new(tls_stream);
    client
        .login(&credentials.email, &credentials.app_password)
        .map_err(|(error, _unused): (imap::Error, imap::Client<native_tls::TlsStream<TcpStream>>)| {
            let message = error.to_string();
            if message.to_ascii_lowercase().contains("authentication")
                || message.to_ascii_lowercase().contains("invalid credentials")
                || message.to_ascii_lowercase().contains("login")
            {
                "reconnect_required".to_string()
            } else {
                sanitize_error(format!("IMAP login failed: {message}"), &credentials.app_password)
            }
        })
}

fn connect_tcp(secret: &str, timeout: Duration) -> Result<TcpStream, String> {
    let addrs: Vec<_> = (IMAP_HOST, IMAP_PORT)
        .to_socket_addrs()
        .map_err(|error| sanitize_error(format!("DNS resolution failed: {error}"), secret))?
        .collect();
    if addrs.is_empty() {
        return Err(sanitize_error(
            "DNS resolution failed: no addresses".to_string(),
            secret,
        ));
    }
    let deadline = Instant::now() + timeout;
    let mut last_error = "TCP connect failed".to_string();
    for addr in addrs {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match TcpStream::connect_timeout(&addr, remaining) {
            Ok(tcp) => return Ok(tcp),
            Err(error) => {
                last_error = format!("TCP connect failed: {error}");
            }
        }
    }
    Err(sanitize_error(last_error, secret))
}

fn with_session<T>(
    credentials: &YahooCredentials,
    work: impl FnOnce(&mut ImapSession) -> Result<T, String>,
) -> Result<T, String> {
    let mut session = connect_session(credentials)?;
    let result = work(&mut session);
    let _ = session.logout();
    result
}

fn capability_to_string(capability: &Capability<'_>) -> String {
    match capability {
        Capability::Imap4rev1 => "IMAP4rev1".to_string(),
        Capability::Auth(value) => format!("AUTH={value}"),
        Capability::Atom(value) => value.to_string(),
    }
}

fn capabilities_to_strings(capabilities: &ImapCapabilities) -> Vec<String> {
    capabilities
        .iter()
        .map(capability_to_string)
        .collect()
}

fn highest_uid_in_mailbox(session: &mut ImapSession) -> Result<u32, String> {
    let fetches = session
        .uid_fetch("1:*", "UID")
        .map_err(|error| format!("UID FETCH failed: {error}"))?;
    Ok(fetches
        .iter()
        .filter_map(|fetch| fetch.uid)
        .max()
        .unwrap_or(0))
}

fn parse_copyuid_destination(response: &[u8]) -> Option<u32> {
    let text = String::from_utf8_lossy(response);
    for line in text.lines() {
        let upper = line.to_ascii_uppercase();
        if !upper.contains("COPYUID") {
            continue;
        }
        let bracket_start = line.find('[')?;
        let bracket_end = line.find(']')?;
        let inner = line[bracket_start + 1..bracket_end].trim();
        let mut parts = inner.split_whitespace();
        let token = parts.next()?;
        if !token.eq_ignore_ascii_case("COPYUID") {
            continue;
        }
        let _uidvalidity = parts.next()?;
        let _source_uids = parts.next()?;
        let destination = parts.next()?;
        if let Some((_, end)) = destination.split_once(':') {
            return end.parse().ok();
        }
        return destination.parse().ok();
    }
    None
}

fn mark_uid_deleted(session: &mut ImapSession, uid: u32) -> Result<(), String> {
    session
        .uid_store(format!("{uid}"), "+FLAGS.SILENT (\\Deleted)")
        .map_err(|error| format!("IMAP UID STORE failed: {error}"))?;
    Ok(())
}

fn uid_expunge_one(session: &mut ImapSession, uid: u32) -> Result<(), String> {
    mark_uid_deleted(session, uid)?;
    session
        .uid_expunge(format!("{uid}"))
        .map_err(|error| format!("IMAP UID EXPUNGE failed: {error}"))?;
    Ok(())
}

fn discover_inbox_name(session: &mut ImapSession) -> Result<String, String> {
    let mailboxes = session
        .list(Some(""), Some("*"))
        .map_err(|error| format!("IMAP LIST failed: {error}"))?;
    for mailbox in mailboxes.iter() {
        if mailbox.name().eq_ignore_ascii_case("INBOX") {
            return Ok(mailbox.name().to_string());
        }
    }
    Ok("INBOX".to_string())
}

fn discover_delimiter(session: &mut ImapSession) -> Result<String, String> {
    let mailboxes = session
        .list(Some(""), Some("*"))
        .map_err(|error| format!("IMAP LIST failed: {error}"))?;
    Ok(mailboxes
        .iter()
        .next()
        .and_then(|mailbox| mailbox.delimiter().map(|value| value.to_string()))
        .unwrap_or_else(|| "/".to_string()))
}

fn parse_references(value: Option<&str>) -> Vec<String> {
    value
        .unwrap_or("")
        .split_whitespace()
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect()
}

fn parse_address_list(value: Option<&str>) -> Vec<String> {
    value
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect()
}

fn parse_received_at(date_header: Option<&str>) -> String {
    let raw = date_header.unwrap_or("").trim();
    if raw.is_empty() {
        return chrono::Utc::now().to_rfc3339();
    }
    if let Ok(parsed) = mailparse::dateparse(raw) {
        if let Some(datetime) = chrono::DateTime::<chrono::Utc>::from_timestamp(parsed, 0) {
            return datetime.to_rfc3339();
        }
    }
    chrono::Utc::now().to_rfc3339()
}

fn extract_message_id_from_header_bytes(header_bytes: &[u8]) -> Result<Option<String>, String> {
    let (headers, _) = mailparse::parse_headers(header_bytes)
        .map_err(|error| format!("Failed to parse header: {error}"))?;
    Ok(headers
        .get_first_value("Message-ID")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty()))
}

fn is_attachment_part(part: &mailparse::ParsedMail<'_>) -> bool {
    part.get_content_disposition().disposition == mailparse::DispositionType::Attachment
}

fn find_mimetype_body(part: &mailparse::ParsedMail<'_>, mimetype: &str) -> Option<String> {
    if is_attachment_part(part) {
        return None;
    }
    if part.ctype.mimetype.eq_ignore_ascii_case(mimetype) {
        if let Ok(body) = part.get_body() {
            if !body.trim().is_empty() {
                return Some(body);
            }
        }
    }
    for subpart in &part.subparts {
        if let Some(body) = find_mimetype_body(subpart, mimetype) {
            return Some(body);
        }
    }
    None
}

fn extract_body_text(parsed: &mailparse::ParsedMail<'_>) -> String {
    find_mimetype_body(parsed, "text/plain")
        .or_else(|| find_mimetype_body(parsed, "text/html"))
        .or_else(|| {
            if parsed.subparts.is_empty() && !is_attachment_part(parsed) {
                parsed.get_body().ok()
            } else {
                None
            }
        })
        .unwrap_or_default()
        .chars()
        .take(MAX_BODY_BYTES)
        .collect()
}

fn message_from_parsed(
    uid: u32,
    parsed: &mailparse::ParsedMail<'_>,
    oversized: bool,
) -> YahooImapMessageResponse {
    let message_id = parsed
        .headers
        .get_first_value("Message-ID")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let references = parse_references(parsed.headers.get_first_value("References").as_deref());
    let in_reply_to = parsed
        .headers
        .get_first_value("In-Reply-To")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let subject = parsed.headers.get_first_value("Subject").unwrap_or_default();
    let from = parsed.headers.get_first_value("From").unwrap_or_default();
    let to = parse_address_list(parsed.headers.get_first_value("To").as_deref());
    let received_at = parse_received_at(parsed.headers.get_first_value("Date").as_deref());
    let body_text = if oversized {
        String::new()
    } else {
        extract_body_text(parsed)
    };
    YahooImapMessageResponse {
        uid,
        message_id,
        references,
        in_reply_to,
        subject,
        from,
        to,
        received_at,
        body_text,
        oversized,
    }
}

fn quarantined_stub(uid: u32) -> YahooImapMessageResponse {
    YahooImapMessageResponse {
        uid,
        message_id: None,
        references: Vec::new(),
        in_reply_to: None,
        subject: String::new(),
        from: String::new(),
        to: Vec::new(),
        received_at: chrono::Utc::now().to_rfc3339(),
        body_text: String::new(),
        oversized: true,
    }
}

fn parse_fetch_message(fetch: &imap::types::Fetch) -> Result<YahooImapMessageResponse, String> {
    let uid = fetch
        .uid
        .ok_or_else(|| "Missing UID in FETCH response".to_string())?;
    let body = fetch.body().unwrap_or_default();
    if body.len() > MAX_TOTAL_RESPONSE_BYTES {
        return Err("IMAP response too large".to_string());
    }
    let parsed =
        mailparse::parse_mail(body).map_err(|error| format!("Failed to parse message: {error}"))?;
    Ok(message_from_parsed(uid, &parsed, false))
}

fn fetch_quarantined_message(
    session: &mut ImapSession,
    uid: u32,
) -> Result<YahooImapMessageResponse, String> {
    let fetches = session
        .uid_fetch(format!("{uid}"), "(UID BODY.PEEK[HEADER])")
        .map_err(|error| format!("IMAP FETCH failed: {error}"))?;
    let Some(fetch) = fetches.iter().next() else {
        return Ok(quarantined_stub(uid));
    };
    let Some(header) = fetch.header() else {
        return Ok(quarantined_stub(uid));
    };
    match mailparse::parse_mail(header) {
        Ok(parsed) => Ok(message_from_parsed(uid, &parsed, true)),
        Err(_) => Ok(quarantined_stub(uid)),
    }
}

fn fetch_one_body_message(
    session: &mut ImapSession,
    uid: u32,
) -> Result<YahooImapMessageResponse, String> {
    let fetches = session
        .uid_fetch(format!("{uid}"), "(UID BODY.PEEK[])")
        .map_err(|error| format!("IMAP FETCH failed: {error}"))?;
    let fetch = fetches
        .iter()
        .next()
        .ok_or_else(|| "Missing FETCH response".to_string())?;
    parse_fetch_message(fetch)
}

fn fetch_inbox_messages(
    session: &mut ImapSession,
    uids: &[u32],
) -> Result<Vec<YahooImapMessageResponse>, String> {
    if uids.is_empty() {
        return Ok(Vec::new());
    }
    let uid_set = uids
        .iter()
        .map(|uid| uid.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let size_fetches = session
        .uid_fetch(&uid_set, "(UID RFC822.SIZE)")
        .map_err(|error| format!("IMAP FETCH failed: {error}"))?;
    let mut sizes = HashMap::new();
    for fetch in size_fetches.iter() {
        if let Some(uid) = fetch.uid {
            sizes.insert(uid, fetch.size);
        }
    }
    let mut messages = Vec::new();
    for uid in uids {
        let known_size = sizes.get(uid).copied().flatten();
        if known_size.is_some_and(|bytes| bytes as usize > MAX_TOTAL_RESPONSE_BYTES) {
            messages.push(fetch_quarantined_message(session, *uid)?);
            continue;
        }
        match fetch_one_body_message(session, *uid) {
            Ok(message) => messages.push(message),
            Err(error) if error == "IMAP response too large" => {
                messages.push(fetch_quarantined_message(session, *uid)?);
            }
            Err(error) => return Err(error),
        }
    }
    Ok(messages)
}

fn select_inbox(session: &mut ImapSession, inbox_name: &str) -> Result<imap::types::Mailbox, String> {
    session
        .select(inbox_name)
        .map_err(|error| format!("IMAP SELECT failed: {error}"))
}

async fn run_blocking<T>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String>
where
    T: Send + 'static,
{
    tokio::time::timeout(
        Duration::from_secs(COMMAND_TIMEOUT_SECS),
        tokio::task::spawn_blocking(work),
    )
    .await
    .map_err(|_| "IMAP command timed out".to_string())?
    .map_err(|error| format!("IMAP worker failed: {error}"))?
}

#[tauri::command]
pub async fn yahoo_imap_discover(
    email: String,
    app_password: String,
) -> Result<YahooImapDiscoverResponse, String> {
    let credentials = YahooCredentials {
        email,
        app_password,
    };
    let secret = credentials.app_password.clone();
    run_blocking(move || {
        with_session(&credentials, |session| {
            let capabilities = session
                .capabilities()
                .map_err(|error| format!("IMAP capability failed: {error}"))?;
            let delimiter = discover_delimiter(session)?;
            let inbox_name = discover_inbox_name(session)?;
            let mailbox = select_inbox(session, &inbox_name)?;
            let uidvalidity = mailbox.uid_validity.unwrap_or(1);
            let highest_uid = if let Some(next) = mailbox.uid_next {
                next.saturating_sub(1)
            } else {
                highest_uid_in_mailbox(session)?
            };
            Ok(YahooImapDiscoverResponse {
                delimiter,
                inbox_name,
                namespace_prefix: None,
                uidvalidity,
                highest_uid,
                supports_move: capabilities.has_str("MOVE"),
                supports_uidplus: capabilities.has_str("UIDPLUS"),
                supports_uid_expunge: capabilities.has_str("UIDPLUS"),
                capabilities: capabilities_to_strings(&capabilities),
            })
        })
        .map_err(|error| sanitize_error(error, &secret))
    })
    .await
}

#[tauri::command]
pub async fn yahoo_imap_fetch_inbox(
    request: YahooImapFetchInboxRequest,
) -> Result<YahooImapFetchInboxResponse, String> {
    let credentials = YahooCredentials {
        email: request.email.clone(),
        app_password: request.app_password.clone(),
    };
    let after_uid = request.after_uid;
    let limit = request.limit.clamp(1, 50) as usize;
    let inbox_name = request.inbox_name.unwrap_or_else(|| "INBOX".to_string());
    let secret = credentials.app_password.clone();
    run_blocking(move || {
        with_session(&credentials, |session| {
            let mailbox = select_inbox(session, &inbox_name)?;
            let uidvalidity = mailbox.uid_validity.unwrap_or(1);
            let query = format!("UID {}:*", after_uid.saturating_add(1));
            let mut uids: Vec<u32> = session
                .uid_search(&query)
                .map_err(|error| format!("IMAP SEARCH failed: {error}"))?
                .into_iter()
                .filter(|uid| *uid > after_uid)
                .collect();
            uids.sort_unstable();
            uids.truncate(limit);
            if uids.is_empty() {
                return Ok(YahooImapFetchInboxResponse {
                    messages: Vec::new(),
                    uidvalidity,
                });
            }
            let mut messages = fetch_inbox_messages(session, &uids)?;
            messages.sort_by_key(|message| message.uid);
            Ok(YahooImapFetchInboxResponse {
                messages,
                uidvalidity,
            })
        })
        .map_err(|error| sanitize_error(error, &secret))
    })
    .await
}

#[tauri::command]
pub async fn yahoo_imap_search_message_id(
    request: YahooImapSearchMessageIdRequest,
) -> Result<Option<u32>, String> {
    let credentials = YahooCredentials {
        email: request.email.clone(),
        app_password: request.app_password.clone(),
    };
    let message_id = request.message_id;
    let inbox_name = request.inbox_name.unwrap_or_else(|| "INBOX".to_string());
    let secret = credentials.app_password.clone();
    run_blocking(move || {
        with_session(&credentials, |session| {
            select_inbox(session, &inbox_name)?;
            let escaped = escape_imap_quoted_string(&message_id)?;
            let query = format!("HEADER Message-ID \"{escaped}\"");
            let mut uids: Vec<u32> = session
                .uid_search(&query)
                .map_err(|error| format!("IMAP SEARCH failed: {error}"))?
                .into_iter()
                .collect();
            uids.sort_unstable();
            Ok(uids.last().copied())
        })
        .map_err(|error| sanitize_error(error, &secret))
    })
    .await
}

#[tauri::command]
pub async fn yahoo_imap_ensure_mailbox(
    request: YahooImapEnsureMailboxRequest,
) -> Result<(), String> {
    let credentials = YahooCredentials {
        email: request.email.clone(),
        app_password: request.app_password.clone(),
    };
    let mailbox_name = request.mailbox_name;
    let secret = credentials.app_password.clone();
    run_blocking(move || {
        with_session(&credentials, |session| {
            let existing = session
                .list(Some(""), Some(mailbox_name.as_str()))
                .map_err(|error| format!("IMAP LIST failed: {error}"))?;
            if existing
                .iter()
                .any(|mailbox| mailbox.name() == mailbox_name)
            {
                return Ok(());
            }
            session
                .create(&mailbox_name)
                .map_err(|error| format!("IMAP CREATE failed: {error}"))
        })
        .map_err(|error| sanitize_error(error, &secret))
    })
    .await
}

#[tauri::command]
pub async fn yahoo_imap_move_uid(
    request: YahooImapUidMailboxRequest,
) -> Result<YahooImapUidActionResponse, String> {
    let credentials = YahooCredentials {
        email: request.email.clone(),
        app_password: request.app_password.clone(),
    };
    let uid = request.uid;
    let mailbox_name = request.mailbox_name.clone();
    let inbox_name = request.inbox_name.unwrap_or_else(|| "INBOX".to_string());
    let secret = credentials.app_password.clone();
    run_blocking(move || {
        with_session(&credentials, |session| {
            select_inbox(session, &inbox_name)?;
            let command = format!(
                "UID MOVE {} {}",
                uid,
                quote_mailbox(&mailbox_name)?
            );
            let response = session
                .run_command_and_read_response(&command)
                .map_err(|error| format!("IMAP MOVE failed: {error}"))?;
            Ok(YahooImapUidActionResponse {
                destination_uid: parse_copyuid_destination(&response),
                destination_mailbox: Some(mailbox_name),
            })
        })
        .map_err(|error| sanitize_error(error, &secret))
    })
    .await
}

#[tauri::command]
pub async fn yahoo_imap_copy_uid(
    request: YahooImapUidMailboxRequest,
) -> Result<YahooImapUidActionResponse, String> {
    let credentials = YahooCredentials {
        email: request.email.clone(),
        app_password: request.app_password.clone(),
    };
    let uid = request.uid;
    let mailbox_name = request.mailbox_name.clone();
    let inbox_name = request.inbox_name.unwrap_or_else(|| "INBOX".to_string());
    let secret = credentials.app_password.clone();
    run_blocking(move || {
        with_session(&credentials, |session| {
            select_inbox(session, &inbox_name)?;
            let command = format!(
                "UID COPY {} {}",
                uid,
                quote_mailbox(&mailbox_name)?
            );
            let response = session
                .run_command_and_read_response(&command)
                .map_err(|error| format!("IMAP COPY failed: {error}"))?;
            Ok(YahooImapUidActionResponse {
                destination_uid: parse_copyuid_destination(&response),
                destination_mailbox: Some(mailbox_name),
            })
        })
        .map_err(|error| sanitize_error(error, &secret))
    })
    .await
}

#[tauri::command]
pub async fn yahoo_imap_uid_expunge(request: YahooImapUidMailboxRequest) -> Result<(), String> {
    let credentials = YahooCredentials {
        email: request.email.clone(),
        app_password: request.app_password.clone(),
    };
    let uid = request.uid;
    let inbox_name = request.inbox_name.unwrap_or_else(|| "INBOX".to_string());
    let secret = credentials.app_password.clone();
    run_blocking(move || {
        with_session(&credentials, |session| {
            select_inbox(session, &inbox_name)?;
            uid_expunge_one(session, uid)
        })
        .map_err(|error| sanitize_error(error, &secret))
    })
    .await
}

#[tauri::command]
pub async fn yahoo_imap_fetch_uid_message_id(
    request: YahooImapFetchUidMessageIdRequest,
) -> Result<Option<String>, String> {
    let credentials = YahooCredentials {
        email: request.email.clone(),
        app_password: request.app_password.clone(),
    };
    let uid = request.uid;
    let inbox_name = request.inbox_name.unwrap_or_else(|| "INBOX".to_string());
    let secret = credentials.app_password.clone();
    run_blocking(move || {
        with_session(&credentials, |session| {
            select_inbox(session, &inbox_name)?;
            let fetches = session
                .uid_fetch(format!("{uid}"), "BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)]")
                .map_err(|error| format!("IMAP FETCH failed: {error}"))?;
            let fetch = fetches
                .iter()
                .next()
                .ok_or_else(|| "Missing FETCH response".to_string())?;
            let header = fetch
                .header()
                .ok_or_else(|| "Missing header in FETCH response".to_string())?;
            extract_message_id_from_header_bytes(header)
        })
        .map_err(|error| sanitize_error(error, &secret))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_imap_quoted_string_escapes_backslash_before_quote() {
        assert_eq!(
            escape_imap_quoted_string(r#"say "hello\world""#).unwrap(),
            r#"say \"hello\\world\""#
        );
    }

    #[test]
    fn escape_imap_quoted_string_rejects_newlines() {
        assert!(escape_imap_quoted_string("line1\r\nline2").is_err());
        assert!(escape_imap_quoted_string("line1\nline2").is_err());
    }

    #[test]
    fn quote_mailbox_escapes_embedded_quotes_and_backslashes() {
        assert_eq!(
            quote_mailbox(r#"Trackdidia "Inbox\Special""#).unwrap(),
            r#""Trackdidia \"Inbox\\Special\"""#
        );
    }

    #[test]
    fn extract_body_text_recurses_nested_multipart() {
        let raw = concat!(
            "Content-Type: multipart/mixed; boundary=\"outer\"\r\n",
            "\r\n",
            "--outer\r\n",
            "Content-Type: multipart/alternative; boundary=\"inner\"\r\n",
            "\r\n",
            "--inner\r\n",
            "Content-Type: text/plain; charset=utf-8\r\n",
            "\r\n",
            "Nested plain body\r\n",
            "--inner--\r\n",
            "--outer\r\n",
            "Content-Type: application/pdf\r\n",
            "Content-Disposition: attachment; filename=\"doc.pdf\"\r\n",
            "\r\n",
            "%PDF-1.4\r\n",
            "--outer--\r\n",
        );
        let parsed = mailparse::parse_mail(raw.as_bytes()).expect("fixture should parse");
        let body = extract_body_text(&parsed);
        assert!(body.contains("Nested plain body"));
    }

    #[test]
    fn extract_body_text_skips_text_attachments() {
        let raw = concat!(
            "Content-Type: multipart/mixed; boundary=\"outer\"\r\n",
            "\r\n",
            "--outer\r\n",
            "Content-Type: text/html; charset=utf-8\r\n",
            "Content-Disposition: inline\r\n",
            "\r\n",
            "<p>Actual message body</p>\r\n",
            "--outer\r\n",
            "Content-Type: text/plain; charset=utf-8\r\n",
            "Content-Disposition: attachment; filename=\"notes.txt\"\r\n",
            "\r\n",
            "PRIVATE ATTACHMENT CONTENT\r\n",
            "--outer--\r\n",
        );
        let parsed = mailparse::parse_mail(raw.as_bytes()).expect("fixture should parse");
        let body = extract_body_text(&parsed);
        assert!(body.contains("<p>Actual message body</p>"));
        assert!(!body.contains("PRIVATE ATTACHMENT CONTENT"));
    }

    #[test]
    fn extract_message_id_from_header_fields_response() {
        let header = b"Message-ID: <abc@example.com>\r\n";
        assert_eq!(
            extract_message_id_from_header_bytes(header).unwrap(),
            Some("<abc@example.com>".to_string())
        );
    }

    #[test]
    fn extract_message_id_returns_none_when_missing() {
        let header = b"Subject: Hello\r\n";
        assert_eq!(extract_message_id_from_header_bytes(header).unwrap(), None);
    }

    #[test]
    fn extract_message_id_trims_whitespace() {
        let header = b"Message-ID:  <spaces@mail>  \r\n";
        assert_eq!(
            extract_message_id_from_header_bytes(header).unwrap(),
            Some("<spaces@mail>".to_string())
        );
    }
}
