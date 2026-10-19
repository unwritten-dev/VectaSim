//! X-Plane Web API messages (developer.x-plane.com/article/x-plane-web-api/):
//!
//! * `GET /api/capabilities` → `{"api":{"versions":["v1","v2"]},"x-plane":{"version":"12.1.4"}}`
//!   (unversioned; X-Plane 12.1.1 answers 404 – then v1 is assumed).
//! * `GET /api/v2/datarefs?filter[name]=a&filter[name]=b` → `{"data":[{"id":…,"name":…,"value_type":…}]}`
//!   (same filters are OR-joined). IDs are valid for the running X-Plane only.
//! * WebSocket `ws://host:port/api/v2`: `{"req_id":1,"type":"dataref_subscribe_values",
//!   "params":{"datarefs":[{"id":…}]}}` → `{"req_id":1,"type":"result","success":true}`;
//!   then `{"type":"dataref_update_values","data":{"<id>":value,…}}` at 10 Hz, the first
//!   one complete, later ones only with changed values. A failed subscription fails every
//!   dataref of its request, so VectaSim subscribes one dataref per request.
//! * Value types: `float`, `double`, `int` (JSON numbers), `int_array`, `float_array`
//!   (JSON arrays) and `data` (base64 string).

use base64::Engine as _;
use serde_json::Value;
use std::collections::HashMap;

/// API versions VectaSim speaks, most preferred first (dataref access is the same in all).
const PREFERRED: [&str; 3] = ["v2", "v3", "v1"];

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Capabilities {
    pub versions: Vec<String>,
    pub xplane_version: Option<String>,
}

pub fn parse_capabilities(body: &str) -> Option<Capabilities> {
    let v: Value = serde_json::from_str(body).ok()?;
    let versions = v
        .pointer("/api/versions")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect())
        .unwrap_or_default();
    let xplane_version = v.pointer("/x-plane/version").and_then(Value::as_str).map(str::to_owned);
    Some(Capabilities { versions, xplane_version })
}

/// `GET /api/v1/datarefs/count` → `{"data":12345}` (X-Plane 12.1.1 and later).
pub fn is_dataref_count(body: &str) -> bool {
    serde_json::from_str::<Value>(body).ok().and_then(|v| v.get("data").and_then(Value::as_u64)).is_some()
}

/// The API version to use: `v2` if offered, else `v3`, `v1`, else whatever comes first;
/// `v1` without a list (12.1.1 has no capabilities endpoint).
pub fn pick_version(caps: &Capabilities) -> String {
    PREFERRED
        .iter()
        .find(|p| caps.versions.iter().any(|v| v == *p))
        .map(|p| (*p).to_owned())
        .or_else(|| caps.versions.first().cloned())
        .unwrap_or_else(|| "v1".into())
}

/// `GET` path resolving `names` (literal `filter[name]=`, as the documentation writes it).
pub fn datarefs_query(api: &str, names: &[&str]) -> String {
    let q: Vec<String> = names.iter().map(|n| format!("filter[name]={n}")).collect();
    format!("/api/{api}/datarefs?{}", q.join("&"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatarefInfo {
    pub id: u64,
    pub value_type: String,
}

/// `{"data":[{id,name,value_type}]}` → name → info.
pub fn parse_datarefs(body: &str) -> Result<HashMap<String, DatarefInfo>, String> {
    let v: Value = serde_json::from_str(body).map_err(|e| format!("dataref list is not JSON: {e}"))?;
    if let Some(err) = api_error(&v) {
        return Err(err);
    }
    let list = v.get("data").and_then(Value::as_array).ok_or("dataref list without \"data\"")?;
    Ok(list
        .iter()
        .filter_map(|d| {
            let id = d.get("id").and_then(Value::as_u64)?;
            let name = d.get("name").and_then(Value::as_str)?;
            let value_type = d.get("value_type").and_then(Value::as_str).unwrap_or_default().to_owned();
            Some((name.to_owned(), DatarefInfo { id, value_type }))
        })
        .collect())
}

/// `error_code: error_message` of an API error document.
pub fn api_error(v: &Value) -> Option<String> {
    let code = v.get("error_code").and_then(Value::as_str)?;
    let msg = v.get("error_message").and_then(Value::as_str).unwrap_or_default();
    Some(format!("{code}: {msg}"))
}

pub fn subscribe_msg(req_id: u64, id: u64) -> String {
    serde_json::json!({ "req_id": req_id, "type": "dataref_subscribe_values", "params": { "datarefs": [{ "id": id }] } }).to_string()
}

#[derive(Debug, Clone, PartialEq)]
pub enum WsMsg {
    /// `dataref_update_values`: (dataref id, value) pairs.
    Update(Vec<(u64, Value)>),
    /// `result` of a request.
    Result { req_id: u64, success: bool, error: Option<String> },
    Other(String),
}

pub fn parse_ws(text: &str) -> Option<WsMsg> {
    let v: Value = serde_json::from_str(text).ok()?;
    let ty = v.get("type").and_then(Value::as_str).unwrap_or_default();
    Some(match ty {
        "dataref_update_values" => {
            let data = v.get("data").and_then(Value::as_object)?;
            // keys are ids as strings (the documentation's example even has a trailing blank)
            let mut u: Vec<(u64, Value)> =
                data.iter().filter_map(|(k, val)| k.trim().parse::<u64>().ok().map(|id| (id, val.clone()))).collect();
            u.sort_by_key(|(id, _)| *id);
            WsMsg::Update(u)
        }
        "result" => WsMsg::Result {
            req_id: v.get("req_id").and_then(Value::as_u64).unwrap_or(0),
            success: v.get("success").and_then(Value::as_bool).unwrap_or(false),
            error: api_error(&v),
        },
        other => WsMsg::Other(other.to_owned()),
    })
}

/// A `data` dataref: base64 of a NUL-padded byte buffer → trimmed text.
pub fn decode_data(v: &Value) -> Option<String> {
    let s = v.as_str()?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(s.trim()).ok()?;
    let end = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
    Some(String::from_utf8_lossy(&bytes[..end]).trim().to_owned())
}

pub fn encode_data(s: &str, len: usize) -> String {
    let mut b = s.as_bytes().to_vec();
    b.resize(len.max(b.len()), 0);
    base64::engine::general_purpose::STANDARD.encode(b)
}

/// A number, or the elements of an array (non-numbers → NaN).
pub fn numbers(v: &Value) -> Vec<f64> {
    match v {
        Value::Array(a) => a.iter().map(|x| x.as_f64().unwrap_or(f64::NAN)).collect(),
        Value::Bool(b) => vec![if *b { 1.0 } else { 0.0 }],
        other => vec![other.as_f64().unwrap_or(f64::NAN)],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_and_version_choice() {
        let c = parse_capabilities(r#"{"api":{"versions":["v1","v2","v3"]},"x-plane":{"version":"12.4.0"}}"#).unwrap();
        assert_eq!(c.xplane_version.as_deref(), Some("12.4.0"));
        assert_eq!(pick_version(&c), "v2");
        assert_eq!(pick_version(&Capabilities { versions: vec!["v1".into()], ..Default::default() }), "v1");
        assert_eq!(pick_version(&Capabilities { versions: vec!["v9".into()], ..Default::default() }), "v9");
        assert_eq!(pick_version(&Capabilities::default()), "v1");
        assert!(parse_capabilities("<html>").is_none());
    }

    #[test]
    fn query_and_dataref_list() {
        assert_eq!(datarefs_query("v2", &["a/b", "c"]), "/api/v2/datarefs?filter[name]=a/b&filter[name]=c");
        let m = parse_datarefs(r#"{"data":[{"id":7,"name":"sim/x","value_type":"float"},{"name":"broken"}]}"#).unwrap();
        assert_eq!(m.len(), 1);
        assert_eq!(m["sim/x"], DatarefInfo { id: 7, value_type: "float".into() });
        let e = parse_datarefs(r#"{"error_code":"invalid_filter","error_message":"bad"}"#).unwrap_err();
        assert_eq!(e, "invalid_filter: bad");
    }

    #[test]
    fn websocket_messages() {
        assert_eq!(
            parse_ws(r#"{"type":"dataref_update_values","data":{"88491":0,"199 ":[0,0,0,4]}}"#),
            Some(WsMsg::Update(vec![(199, serde_json::json!([0, 0, 0, 4])), (88491, serde_json::json!(0))]))
        );
        assert_eq!(
            parse_ws(r#"{"req_id":5,"type":"result","success":false,"error_code":"invalid_dataref_id","error_message":"Dataref 5 doesn't exist"}"#),
            Some(WsMsg::Result { req_id: 5, success: false, error: Some("invalid_dataref_id: Dataref 5 doesn't exist".into()) })
        );
        let s = subscribe_msg(3, 42);
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["params"]["datarefs"][0]["id"], 42);
        assert_eq!(v["type"], "dataref_subscribe_values");
    }

    #[test]
    fn base64_strings_and_numbers() {
        let e = encode_data("C172", 40);
        assert_eq!(decode_data(&Value::String(e)).as_deref(), Some("C172"));
        assert_eq!(decode_data(&Value::from(3)), None);
        assert_eq!(numbers(&serde_json::json!([1, 2.5, null])).len(), 3);
        assert_eq!(numbers(&serde_json::json!(4)), vec![4.0]);
    }
}
