// AI 编辑的后端：只做两件事 —— 安全保存配置、代前端调用 OpenAI 兼容接口。
//
// 为什么放在 Rust：
// 1. API Key 不该进 WebView。存本地文件（Unix 下 0600），前端只拿得到「是否已配置 + 末四位」；
// 2. 浏览器的 fetch 会被 CORS 挡住（直连 api.deepseek.com 这类服务），Rust 侧没有这个限制；
// 3. 超时、错误信息可以统一成用户能看懂的话，而不是 "TypeError: Failed to fetch"。
//
// 只支持 OpenAI 兼容协议（/chat/completions + /models）：
// DeepSeek、OpenAI、Moonshot、智谱、SiliconFlow、Ollama、vLLM、LM Studio 都吃这一套。
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

#[derive(Serialize, Deserialize, Clone)]
pub struct AiConfig {
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default = "default_temperature")]
    pub temperature: f32,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    /// 服务商特有参数，存 JSON 对象文本；会在请求体最后合并（如 thinking / reasoning_effort）
    #[serde(default = "default_extra_body")]
    pub extra_body: String,
    /// 有些模型（Kimi K3、GLM-5.3 等）固定温度或拒绝 temperature，必须整个字段不发
    #[serde(default)]
    pub skip_temperature: bool,
}

fn default_temperature() -> f32 {
    0.3
}
fn default_max_tokens() -> u32 {
    4096
}
fn default_extra_body() -> String {
    "{}".to_string()
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            provider: "custom".into(),
            base_url: String::new(),
            model: String::new(),
            api_key: String::new(),
            temperature: default_temperature(),
            max_tokens: default_max_tokens(),
            extra_body: default_extra_body(),
            skip_temperature: false,
        }
    }
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{}", e))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败：{}", e))?;
    Ok(dir.join("ai-config.json"))
}

fn load_config(app: &tauri::AppHandle) -> Result<AiConfig, String> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(AiConfig::default());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("读取 AI 配置失败：{}", e))?;
    // 配置损坏时不要炸掉整个功能，回落到默认值让用户重填。
    // 不做模型名自动迁移：用户自己填什么就用什么，避免绕过他们的选择。
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

fn save_config(app: &tauri::AppHandle, cfg: &AiConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let text = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("写入 AI 配置失败：{}", e))?;
    // 只有当前用户可读：密钥是本机敏感信息
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// 给前端看的配置视图：不含 key 明文，只给「有没有」和末四位。
#[tauri::command]
pub fn ai_config_get(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let cfg = load_config(&app)?;
    let hint = if cfg.api_key.len() >= 4 {
        format!("••••{}", &cfg.api_key[cfg.api_key.len() - 4..])
    } else if cfg.api_key.is_empty() {
        String::new()
    } else {
        "••••".to_string()
    };
    Ok(serde_json::json!({
        "provider": cfg.provider,
        "base_url": cfg.base_url,
        "model": cfg.model,
        "temperature": cfg.temperature,
        "max_tokens": cfg.max_tokens,
        "extra_body": cfg.extra_body,
        "skip_temperature": cfg.skip_temperature,
        "has_key": !cfg.api_key.is_empty(),
        "key_hint": hint,
        "config_dir": config_path(&app)?.to_string_lossy().to_string(),
    }))
}

/// 保存配置。api_key 传空字符串表示「保持原来的 key 不变」（用户的常见操作是只改模型）。
#[tauri::command]
pub fn ai_config_set(
    app: tauri::AppHandle,
    provider: String,
    base_url: String,
    model: String,
    api_key: Option<String>,
    temperature: Option<f32>,
    max_tokens: Option<u32>,
    extra_body: Option<String>,
    skip_temperature: Option<bool>,
) -> Result<(), String> {
    let mut cfg = load_config(&app)?;
    cfg.provider = provider;
    cfg.base_url = base_url.trim().trim_end_matches('/').to_string();
    cfg.model = model.trim().to_string();
    if let Some(k) = api_key {
        let k = k.trim().to_string();
        if !k.is_empty() {
            cfg.api_key = k;
        }
    }
    if let Some(t) = temperature {
        cfg.temperature = t.clamp(0.0, 1.5);
    }
    if let Some(m) = max_tokens {
        cfg.max_tokens = m.clamp(256, 32000);
    }
    if let Some(extra) = extra_body {
        let extra = extra.trim();
        if !extra.is_empty() {
            // 提前拦掉非法 JSON，避免到了请求时才失败
            let v: serde_json::Value =
                serde_json::from_str(extra).map_err(|e| format!("额外参数不是合法 JSON：{}", e))?;
            if !v.is_object() {
                return Err("额外参数必须是一个 JSON 对象，例如 {\"reasoning_effort\":\"none\"}".to_string());
            }
            cfg.extra_body = extra.to_string();
        }
    }
    if let Some(skip) = skip_temperature {
        cfg.skip_temperature = skip;
    }
    save_config(&app, &cfg)
}

#[tauri::command]
pub fn ai_config_clear_key(app: tauri::AppHandle) -> Result<(), String> {
    let mut cfg = load_config(&app)?;
    cfg.api_key.clear();
    save_config(&app, &cfg)
}

/// content 支持两种形态：纯文本字符串，或 OpenAI 多模态数组
/// `[{"type":"text","text":"…"},{"type":"image_url","image_url":{"url":"data:image/png;base64,…"}}]`。
/// 用 Value 原样透传给服务商，编辑器不解释其内容。
#[derive(Deserialize, Serialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: serde_json::Value,
}

fn friendly_error(err: &reqwest::Error) -> String {
    if err.is_timeout() {
        return "请求超时：模型响应太慢，或接口地址不可达".to_string();
    }
    if err.is_connect() {
        return "连不上接口地址：检查 Base URL，本地模型要确认服务已启动".to_string();
    }
    if err.is_request() {
        return format!("请求无法发出：{}", err);
    }
    format!("网络错误：{}", err)
}

fn truncate(s: &str, max: usize) -> String {
    let mut out: String = s.chars().take(max).collect();
    if s.chars().count() > max {
        out.push('…');
    }
    out
}

fn endpoint(cfg: &AiConfig, path: &str) -> String {
    format!("{}/{}", cfg.base_url.trim_end_matches('/'), path)
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(150))
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("初始化 HTTP 客户端失败：{}", e))
}

fn merge_extras(mut body: serde_json::Value, cfg: &AiConfig) -> Result<serde_json::Value, String> {
    if !cfg.extra_body.trim().is_empty() {
        let extra: serde_json::Value = serde_json::from_str(cfg.extra_body.trim())
            .map_err(|e| format!("AI 额外参数不是合法 JSON：{}", e))?;
        if let Some(obj) = extra.as_object() {
            const RESERVED: &[&str] = &["model", "messages", "max_tokens", "stream"];
            for (k, v) in obj {
                if RESERVED.contains(&k.as_str()) {
                    continue;
                }
                // skip_temperature 时允许 extra_body 显式指定 temperature（如 GLM 要求 1）
                body[k.as_str()] = v.clone();
            }
        }
    }
    Ok(body)
}

/// 组装请求体：基础字段 + 服务商特有参数。
/// extra_body 里的键不能覆盖核心字段，避免用户误配后把 messages 冲掉。
fn build_body(
    cfg: &AiConfig,
    messages: Vec<ChatMessage>,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
) -> Result<serde_json::Value, String> {
    let mut body = serde_json::json!({
        "model": cfg.model,
        "messages": messages,
        "max_tokens": max_tokens.unwrap_or(cfg.max_tokens),
        "stream": false,
    });
    if !cfg.skip_temperature {
        body["temperature"] = serde_json::json!(temperature.unwrap_or(cfg.temperature));
    }
    merge_extras(body, cfg)
}

fn build_stream_body(
    cfg: &AiConfig,
    messages: Vec<ChatMessage>,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
    web_search: bool,
) -> Result<serde_json::Value, String> {
    let mut body = serde_json::json!({
        "model": cfg.model,
        "messages": messages,
        "max_tokens": max_tokens.unwrap_or(cfg.max_tokens),
        "stream": true,
    });
    if !cfg.skip_temperature {
        body["temperature"] = serde_json::json!(temperature.unwrap_or(cfg.temperature));
    }
    // 联网搜索：不同 OpenAI 兼容服务商字段各异，这里放最常见的一组。
    // 未知字段通常被忽略，用户仍可用 extra_body 覆盖或补充服务商特定字段。
    if web_search {
        body["web_search"] = serde_json::json!(true);
        body["web_search_options"] = serde_json::json!({});
    }
    merge_extras(body, cfg)
}

/// 从 SSE 事件 JSON 里采集 url_citation / citations 标注，归一化成 {url, title}。
/// 兼容 OpenAI responses 的 `annotations[].type == "url_citation"`、
/// 以及部分服务商直接给的 `citations` / `search_results` 数组。
fn collect_citations(j: &serde_json::Value) -> Vec<serde_json::Value> {
    use serde_json::Value;
    let mut out: Vec<Value> = Vec::new();
    let mut nodes: Vec<&Value> = Vec::new();
    if let Some(a) = j.get("annotations") { nodes.push(a); }
    if let Some(a) = j["choices"][0].get("message").and_then(|m| m.get("annotations")) { nodes.push(a); }
    if let Some(a) = j["choices"][0].get("delta").and_then(|d| d.get("annotations")) { nodes.push(a); }
    if let Some(a) = j.get("citations") { nodes.push(a); }
    if let Some(a) = j.get("search_results") { nodes.push(a); }
    for node in nodes {
        let Some(arr) = node.as_array() else { continue };
        for item in arr {
            // url_citation 通常包一层 { type, url_citation: {url, title, ...} }
            let uc = if item.get("type").and_then(|t| t.as_str()) == Some("url_citation") {
                item.get("url_citation").unwrap_or(item)
            } else {
                item
            };
            let url = uc.get("url").and_then(|v| v.as_str())
                .or_else(|| uc.get("link").and_then(|v| v.as_str()));
            if let Some(u) = url {
                if u.trim().is_empty() { continue }
                let title = uc.get("title").and_then(|v| v.as_str())
                    .or_else(|| uc.get("name").and_then(|v| v.as_str()))
                    .unwrap_or(u);
                out.push(serde_json::json!({ "url": u, "title": title }));
            }
        }
    }
    out
}

/// 流式请求的取消标记。每个 request_id 一个 AtomicBool，前端点「停止」时置 true。
#[derive(Default)]
pub struct StreamCancels(pub Mutex<HashMap<String, Arc<AtomicBool>>>);

fn stream_cancel_flag(state: &tauri::State<'_, StreamCancels>, request_id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    state
        .0
        .lock()
        .unwrap()
        .insert(request_id.to_string(), flag.clone());
    flag
}

fn stream_cleanup(state: &tauri::State<'_, StreamCancels>, request_id: &str) {
    state.0.lock().unwrap().remove(request_id);
}

fn emit_stream(app: &tauri::AppHandle, request_id: &str, kind: &str, payload: serde_json::Value) {
    let _ = app.emit(
        "ai-chat-stream",
        serde_json::json!({
            "request_id": request_id,
            "type": kind,
            "payload": payload,
        }),
    );
}

/// HTTP 状态码 → 可行动的中文提示。流式与一次性请求共用，避免两处提示漂移。
fn error_hint(code: u16) -> &'static str {
    match code {
        401 | 403 => "（API Key 无效或无权限）",
        404 => "（接口路径不对，Base URL 通常需要以 /v1 结尾）",
        429 => "（触发限流，稍后再试）",
        402 => "（账户余额不足）",
        _ => "",
    }
}

fn sse_error_hint(status: reqwest::StatusCode) -> &'static str {
    error_hint(status.as_u16())
}

/// 流式聊天：把 OpenAI 兼容 SSE 转成 tauri 事件发给前端，同时返回最终结果。
#[tauri::command]
pub async fn ai_chat_stream(
    app: tauri::AppHandle,
    state: tauri::State<'_, StreamCancels>,
    request_id: String,
    messages: Vec<ChatMessage>,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
    web_search: Option<bool>,
) -> Result<serde_json::Value, String> {
    let cfg = load_config(&app)?;
    if cfg.base_url.trim().is_empty() || cfg.model.trim().is_empty() {
        return Err("AI 还没配置：请到 设置 → AI 填入接口地址和模型".to_string());
    }
    if cfg.api_key.is_empty()
        && !cfg.base_url.contains("localhost")
        && !cfg.base_url.contains("127.0.0.1")
    {
        return Err("还没有填 API Key：请到 设置 → AI 配置".to_string());
    }

    let web_search = web_search.unwrap_or(false);
    let body = build_stream_body(&cfg, messages, max_tokens, temperature, web_search)?;
    let cancel = stream_cancel_flag(&state, &request_id);
    // 联网请求先告诉前端进入搜索态（正文尚未开始流出）。
    if web_search {
        emit_stream(&app, &request_id, "searching", serde_json::json!({}));
    }

    let mut req = client()?
        .post(endpoint(&cfg, "chat/completions"))
        .json(&body);
    if !cfg.api_key.is_empty() {
        req = req.bearer_auth(&cfg.api_key);
    }

    let started = Instant::now();
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            stream_cleanup(&state, &request_id);
            let msg = friendly_error(&e);
            emit_stream(&app, &request_id, "error", serde_json::json!({ "message": msg }));
            return Err(msg);
        }
    };

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        stream_cleanup(&state, &request_id);
        let msg = format!(
            "接口返回 {} {}{}\n{}",
            status.as_u16(),
            status.canonical_reason().unwrap_or(""),
            sse_error_hint(status),
            truncate(text.trim(), 500)
        );
        emit_stream(&app, &request_id, "error", serde_json::json!({ "message": msg }));
        return Err(msg);
    }

    let mut buf = String::new();
    let mut content = String::new();
    let mut model = cfg.model.clone();
    let mut usage = serde_json::Value::Null;
    let mut finish_reason = String::new();
    let mut citations: Vec<serde_json::Value> = Vec::new();
    let mut push_citations = |j: &serde_json::Value| {
        for c in collect_citations(j) {
            let url = c["url"].as_str().unwrap_or("");
            if !citations.iter().any(|x| x["url"].as_str() == Some(url)) {
                citations.push(c);
            }
        }
    };

    let mut stream = resp.bytes_stream();
    while let Some(item) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            stream_cleanup(&state, &request_id);
            emit_stream(&app, &request_id, "cancelled", serde_json::json!({ "content": content }));
            return Ok(serde_json::json!({
                "content": content,
                "model": model,
                "usage": usage,
                "finish_reason": "cancelled",
                "latency_ms": started.elapsed().as_millis(),
                "cancelled": true,
                "citations": citations,
            }));
        }
        let chunk = match item {
            Ok(c) => c,
            Err(e) => {
                stream_cleanup(&state, &request_id);
                let msg = format!("流式读取失败：{}", e);
                emit_stream(&app, &request_id, "error", serde_json::json!({ "message": msg }));
                return Err(msg);
            }
        };
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(pos) = buf.find("\n\n") {
            let event = buf[..pos].to_string();
            buf.drain(..pos + 2);
            for line in event.lines() {
                let Some(data) = line.strip_prefix("data:") else { continue };
                let data = data.trim_start();
                if data == "[DONE]" {
                    continue;
                }
                let Ok(j) = serde_json::from_str::<serde_json::Value>(data) else { continue };
                push_citations(&j);
                if let Some(m) = j["model"].as_str() {
                    if !m.is_empty() {
                        model = m.to_string();
                    }
                }
                if !j["usage"].is_null() {
                    usage = j["usage"].clone();
                }
                if let Some(f) = j["choices"][0]["finish_reason"].as_str() {
                    if !f.is_empty() {
                        finish_reason = f.to_string();
                    }
                }
                if let Some(delta) = j["choices"][0]["delta"]["content"].as_str() {
                    if !delta.is_empty() {
                        content.push_str(delta);
                        emit_stream(
                            &app,
                            &request_id,
                            "chunk",
                            serde_json::json!({ "delta": delta }),
                        );
                    }
                } else if let Some(reasoning) = j["choices"][0]["delta"]["reasoning_content"].as_str() {
                    // 推理型模型会先输出 reasoning_content；不展示原文，只让用户知道模型在思考
                    if !reasoning.is_empty() {
                        emit_stream(&app, &request_id, "thinking", serde_json::json!({}));
                    }
                }
            }
        }
    }

    stream_cleanup(&state, &request_id);
    let latency_ms = started.elapsed().as_millis();
    emit_stream(
        &app,
        &request_id,
        "done",
        serde_json::json!({
            "content": content,
            "model": model,
            "usage": usage,
            "finish_reason": finish_reason,
            "latency_ms": latency_ms,
            "citations": citations,
        }),
    );
    Ok(serde_json::json!({
        "content": content,
        "model": model,
        "usage": usage,
        "finish_reason": finish_reason,
        "latency_ms": latency_ms,
        "cancelled": false,
        "citations": citations,
    }))
}

/// 停止一个进行中的流式请求。
#[tauri::command]
pub fn ai_chat_stream_cancel(state: tauri::State<'_, StreamCancels>, request_id: String) -> Result<(), String> {
    if let Some(flag) = state.0.lock().unwrap().get(&request_id) {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

/// 主调用：把 messages 发给模型，返回正文 + 用量 + 耗时。
/// 组装请求体：基础字段 + 服务商特有参数。

/// 主调用：把 messages 发给模型，返回正文 + 用量 + 耗时。
/// max_tokens / temperature 可按次覆盖：补丁式编辑只需要很短的输出，把上限压小既省钱也更快，
/// 而整篇改写（回退路径）需要更大的空间。
#[tauri::command]
pub async fn ai_chat(
    app: tauri::AppHandle,
    messages: Vec<ChatMessage>,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
) -> Result<serde_json::Value, String> {
    let cfg = load_config(&app)?;
    if cfg.base_url.trim().is_empty() || cfg.model.trim().is_empty() {
        return Err("AI 还没配置：请到 设置 → AI 填入接口地址和模型".to_string());
    }
    if cfg.api_key.is_empty() && !cfg.base_url.contains("localhost") && !cfg.base_url.contains("127.0.0.1") {
        return Err("还没有填 API Key：请到 设置 → AI 配置".to_string());
    }

    let body = build_body(&cfg, messages, max_tokens, temperature)?;

    let mut req = client()?.post(endpoint(&cfg, "chat/completions")).json(&body);
    if !cfg.api_key.is_empty() {
        req = req.bearer_auth(&cfg.api_key);
    }

    let started = Instant::now();
    let resp = req.send().await.map_err(|e| friendly_error(&e))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("读取响应失败：{}", e))?;

    if !status.is_success() {
        // 把服务端的错误结构尽量原样带回（401 是 key 错，429 是限流，402 是欠费）
        let hint = error_hint(status.as_u16());
        return Err(format!(
            "接口返回 {} {}{}",
            status.as_u16(),
            status.canonical_reason().unwrap_or(""),
            hint
        ) + &format!("\n{}", truncate(text.trim(), 500)));
    }

    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("响应不是合法 JSON：{}", e))?;
    let choice = &value["choices"][0];
    let content = choice["message"]["content"].as_str().unwrap_or("").to_string();
    if content.trim().is_empty() {
        let finish = choice["finish_reason"].as_str().unwrap_or("");
        let has_reasoning = choice["message"]["reasoning_content"]
            .as_str()
            .map(|r| !r.trim().is_empty())
            .unwrap_or(false);
        let hint = if finish == "length" && has_reasoning {
            "（输出被 max_tokens 截断：模型先把 token 用在 reasoning_content 上了；请增大 max_tokens，或换一个非推理模型）"
        } else if finish == "length" {
            "（输出被 max_tokens 截断，请增大 max_tokens）"
        } else {
            ""
        };
        return Err(format!("模型没有返回内容{}：{}", hint, truncate(&text, 300)));
    }

    Ok(serde_json::json!({
        "content": content,
        "model": value["model"].as_str().unwrap_or(&cfg.model),
        "usage": value["usage"],
        // length = 撞到 max_tokens 被截断：前端据此判定「补丁不完整」，而不是猜 END 有没有写
        "finish_reason": value["choices"][0]["finish_reason"].as_str().unwrap_or(""),
        "latency_ms": started.elapsed().as_millis(),
    }))
}

/// 配置页的「测试连接」：验证地址/密钥/模型三者都通。
///
/// 注意：不能用 16 token 这种「最短请求」。DeepSeek-V4-Flash、GLM-5.3、Kimi K3
/// 这类推理模型会先输出 reasoning_content，16 token 还没到正文就被截断了。
/// 这里给两档预算，第一档失败且明显是空正文时自动加大一次。
#[tauri::command]
pub async fn ai_test(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let started = Instant::now();
    let mut last_error = String::new();

    for budget in [512u32, 2048u32] {
        let res = ai_chat(
            app.clone(),
            vec![ChatMessage {
                role: "user".into(),
                content: serde_json::json!("只回复两个字：可用"),
            }],
            Some(budget),
            Some(0.0),
        )
        .await;

        match res {
            Ok(r) => {
                return Ok(serde_json::json!({
                    "ok": true,
                    "reply": r["content"],
                    "model": r["model"],
                    "latency_ms": started.elapsed().as_millis(),
                }));
            }
            Err(e) => {
                // 401/404/429 这类错误重试没意义，直接返回
                if !e.contains("模型没有返回内容") {
                    return Err(e);
                }
                last_error = e;
            }
        }
    }

    Err(format!(
        "连接测试失败：{}。这个模型可能把所有输出都用在思考上；请在设置里增大 max_tokens，或换一个非推理模型。",
        last_error
    ))
}

/// 拉取模型列表（GET /models）：选模型时不用手打名字。
#[tauri::command]
pub async fn ai_models(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let cfg = load_config(&app)?;
    if cfg.base_url.trim().is_empty() {
        return Err("先填 Base URL".to_string());
    }
    let mut req = client()?.get(endpoint(&cfg, "models"));
    if !cfg.api_key.is_empty() {
        req = req.bearer_auth(&cfg.api_key);
    }
    let resp = req.send().await.map_err(|e| friendly_error(&e))?;
    if !resp.status().is_success() {
        return Err(format!("拉取模型失败：HTTP {}", resp.status().as_u16()));
    }
    let value: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let mut list: Vec<String> = value["data"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m["id"].as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    list.sort();
    list.dedup();
    if list.is_empty() {
        return Err("接口没有返回模型列表（可以手动填模型名）".to_string());
    }
    Ok(list)
}


#[cfg(test)]
mod tests {
    use super::*;

    fn msg() -> Vec<ChatMessage> {
        vec![ChatMessage {
            role: "user".into(),
            content: serde_json::json!("hi"),
        }]
    }

    #[test]
    fn error_hints_cover_auth_path_rate_and_balance() {
        assert!(error_hint(401).contains("API Key"));
        assert!(error_hint(403).contains("API Key"));
        assert!(error_hint(404).contains("Base URL"));
        assert!(error_hint(429).contains("限流"));
        assert!(error_hint(402).contains("余额"));
        assert_eq!(error_hint(500), "");
    }

    #[test]
    fn multimodal_content_passes_through_unchanged() {
        let content = serde_json::json!([
            { "type": "text", "text": "这张图是什么" },
            { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } }
        ]);
        let msgs = vec![ChatMessage { role: "user".into(), content: content.clone() }];
        let body = build_body(&AiConfig::default(), msgs, None, None).unwrap();
        assert_eq!(body["messages"][0]["content"], content);
        assert_eq!(body["messages"][0]["content"][1]["type"], "image_url");
    }

    #[test]
    fn body_includes_temperature_by_default() {
        let cfg = AiConfig::default();
        let body = build_body(&cfg, msg(), Some(1200), Some(0.15)).unwrap();
        let t = body["temperature"].as_f64().unwrap();
        assert!((t - 0.15).abs() < 1e-6, "temperature={}", t);
        assert_eq!(body["max_tokens"], 1200);
        assert_eq!(body["stream"], false);
    }

    #[test]
    fn skip_temperature_drops_field_but_extra_can_restore_it() {
        let mut cfg = AiConfig::default();
        cfg.skip_temperature = true;
        let body = build_body(&cfg, msg(), None, Some(0.15)).unwrap();
        assert!(body.get("temperature").is_none());

        cfg.extra_body = r#"{"temperature":1,"thinking":{"type":"enabled"},"reasoning_effort":"low"}"#.into();
        let body = build_body(&cfg, msg(), None, Some(0.15)).unwrap();
        assert_eq!(body["temperature"], 1);
        assert_eq!(body["thinking"]["type"], "enabled");
        assert_eq!(body["reasoning_effort"], "low");
    }

    #[test]
    fn stream_body_marks_stream_true() {
        let cfg = AiConfig::default();
        let body = build_stream_body(&cfg, msg(), Some(256), Some(0.2)).unwrap();
        assert_eq!(body["stream"], true);
        assert_eq!(body["max_tokens"], 256);
    }

    #[test]
    fn extra_body_cannot_override_core_fields() {
        let mut cfg = AiConfig::default();
        cfg.extra_body = r#"{"model":"evil","messages":[],"reasoning_effort":"none"}"#.into();
        let body = build_body(&cfg, msg(), None, None).unwrap();
        assert_eq!(body["model"], cfg.model);
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
        assert_eq!(body["reasoning_effort"], "none");
    }

}
