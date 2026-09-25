use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use karazhan_core::{
    Database,
    application::{Application, Query, QueryResult, share_application},
};
use karazhan_http_adapter::{HttpAdapter, HttpAdapterError};
use karazhan_tauri_adapter::TauriAdapter;
use serde_json::{Value, json};
use tower::ServiceExt;

const API_ADDR: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 47_831);

fn adapter() -> HttpAdapter {
    HttpAdapter::new(
        Application::new(Database::open_in_memory().expect("in-memory database")),
        API_ADDR,
    )
    .expect("valid loopback adapter")
}

fn query_request(token: Option<&str>, host: &str, origin: Option<&str>) -> Request<Body> {
    let mut builder = Request::post("/v1/query")
        .header("content-type", "application/json")
        .header("host", host);
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    if let Some(origin) = origin {
        builder = builder.header("origin", origin);
    }
    builder
        .body(Body::from(r#"{"type":"list_projects"}"#))
        .expect("request")
}

async fn error_code(response: axum::response::Response) -> String {
    let body = to_bytes(response.into_body(), 16 * 1024)
        .await
        .expect("response body");
    serde_json::from_slice::<Value>(&body).expect("JSON error")["code"]
        .as_str()
        .expect("error code")
        .to_owned()
}

#[test]
fn only_explicit_loopback_addresses_are_accepted() {
    for address in ["0.0.0.0:47831", "192.168.1.20:47831", "[::]:47831"] {
        let error = HttpAdapter::new(
            Application::new(Database::open_in_memory().expect("in-memory database")),
            address.parse().expect("socket address"),
        )
        .expect_err("non-loopback bind must fail");
        assert!(matches!(error, HttpAdapterError::NonLoopbackBind(_)));
    }
}

#[test]
fn tokens_are_256_bit_random_hex_values() {
    let first = adapter();
    let second = adapter();

    assert_eq!(first.token().len(), 64);
    assert!(first.token().bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert_ne!(first.token(), second.token());
}

#[tokio::test]
async fn valid_token_host_and_origin_reach_the_shared_query_contract() {
    let adapter = adapter();
    let response = adapter
        .router()
        .oneshot(query_request(
            Some(adapter.token()),
            "127.0.0.1:47831",
            Some("http://127.0.0.1:47831"),
        ))
        .await
        .expect("HTTP response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 16 * 1024)
        .await
        .expect("response body");
    assert_eq!(
        serde_json::from_slice::<Value>(&body).expect("query result"),
        json!({ "type": "projects", "payload": [] })
    );
}

#[tokio::test]
async fn missing_or_wrong_tokens_are_rejected() {
    let adapter = adapter();
    for token in [None, Some("wrong-token")] {
        let response = adapter
            .router()
            .oneshot(query_request(token, "127.0.0.1:47831", None))
            .await
            .expect("HTTP response");
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(error_code(response).await, "unauthorized");
    }
}

#[tokio::test]
async fn mismatched_host_or_origin_is_rejected_before_dispatch() {
    let adapter = adapter();

    let response = adapter
        .router()
        .oneshot(query_request(
            Some(adapter.token()),
            "attacker.example:47831",
            None,
        ))
        .await
        .expect("HTTP response");
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(error_code(response).await, "invalid_host");

    let response = adapter
        .router()
        .oneshot(query_request(
            Some(adapter.token()),
            "127.0.0.1:47831",
            Some("https://attacker.example"),
        ))
        .await
        .expect("HTTP response");
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(error_code(response).await, "invalid_origin");
}

#[tokio::test]
async fn occupied_port_fails_on_the_configured_address_and_leaves_desktop_core_usable() {
    let occupied = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("reserve loopback port");
    let configured_address = occupied.local_addr().expect("reserved address");
    let application = share_application(Application::new(
        Database::open_in_memory().expect("in-memory database"),
    ));
    let desktop = TauriAdapter::from_shared(application.clone());
    let http = HttpAdapter::from_shared(application, configured_address)
        .expect("valid loopback configuration");

    let error = http
        .serve()
        .await
        .expect_err("occupied configured port must fail startup");
    assert!(matches!(
        error,
        HttpAdapterError::Bind { address, .. } if address == configured_address
    ));

    let QueryResult::Projects(projects) = desktop
        .query(Query::ListProjects)
        .expect("desktop core remains usable")
    else {
        panic!("unexpected desktop query result");
    };
    assert!(projects.is_empty());
}
