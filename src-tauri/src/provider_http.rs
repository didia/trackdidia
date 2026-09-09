use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const DEFAULT_TIMEOUT_MS: u64 = 20_000;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderHttpRequest {
    pub method: String,
    pub url: String,
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderHttpResponse {
    pub status: u16,
    pub body: String,
}

fn sanitize_error_message(message: String) -> String {
    message
        .lines()
        .map(str::trim)
        .filter(|line| {
            !line.to_ascii_lowercase().contains("authorization")
                && !line.to_ascii_lowercase().contains("bearer ")
        })
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(400)
        .collect()
}

#[tauri::command]
pub async fn provider_http_request(request: ProviderHttpRequest) -> Result<ProviderHttpResponse, String> {
    let method = Method::from_bytes(request.method.as_bytes())
        .map_err(|error| format!("Invalid HTTP method: {error}"))?;
    let timeout_ms = request.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).clamp(1_000, 120_000);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .build()
        .map_err(|error| sanitize_error_message(format!("HTTP client failed: {error}")))?;

    let mut headers = HeaderMap::new();
    for (name, value) in request.headers {
        let header_name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|error| format!("Invalid header name: {error}"))?;
        let header_value = HeaderValue::from_str(&value)
            .map_err(|error| format!("Invalid header value: {error}"))?;
        headers.insert(header_name, header_value);
    }

    let mut builder = client.request(method, &request.url).headers(headers);
    if let Some(body) = request.body {
        builder = builder.body(body);
    }

    let response = builder
        .send()
        .await
        .map_err(|error| sanitize_error_message(format!("HTTP request failed: {error}")))?;

    let status = response.status().as_u16();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| sanitize_error_message(format!("HTTP response unreadable: {error}")))?;

    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("HTTP response too large".to_string());
    }

    let body = String::from_utf8(bytes.to_vec())
        .map_err(|_| "HTTP response is not valid UTF-8".to_string())?;

    Ok(ProviderHttpResponse { status, body })
}
