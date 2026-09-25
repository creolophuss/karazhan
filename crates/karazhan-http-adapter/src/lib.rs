//! Loopback HTTP adapter for the shared Karazhan application contract.

use std::{fmt, net::SocketAddr, sync::Arc};

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::post,
};
use karazhan_core::{
    DomainError,
    application::{
        Application, Command, CommandResult, Query, QueryResult, SharedApplication,
        share_application,
    },
};
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum HttpAdapterError {
    #[error("HTTP API address is not loopback: {0}")]
    NonLoopbackBind(SocketAddr),
    #[error("operating system random source is unavailable")]
    EntropyUnavailable,
    #[error("failed to bind HTTP API to {address}: {source}")]
    Bind {
        address: SocketAddr,
        #[source]
        source: std::io::Error,
    },
    #[error("HTTP API server failed: {0}")]
    Serve(#[source] std::io::Error),
}

#[derive(Clone)]
struct HttpState {
    application: SharedApplication,
    token: Arc<str>,
    authority: Arc<str>,
    origin: Arc<str>,
}

pub struct HttpAdapter {
    bind_address: SocketAddr,
    state: HttpState,
}

impl fmt::Debug for HttpAdapter {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HttpAdapter")
            .field("bind_address", &self.bind_address)
            .finish_non_exhaustive()
    }
}

impl HttpAdapter {
    pub fn new(
        application: Application,
        bind_address: SocketAddr,
    ) -> Result<Self, HttpAdapterError> {
        Self::from_shared(share_application(application), bind_address)
    }

    pub fn from_shared(
        application: SharedApplication,
        bind_address: SocketAddr,
    ) -> Result<Self, HttpAdapterError> {
        if !bind_address.ip().is_loopback() {
            return Err(HttpAdapterError::NonLoopbackBind(bind_address));
        }

        let token = generate_token()?;
        let authority = bind_address.to_string();
        let origin = format!("http://{authority}");
        Ok(Self {
            bind_address,
            state: HttpState {
                application,
                token: token.into(),
                authority: authority.into(),
                origin: origin.into(),
            },
        })
    }

    pub fn token(&self) -> &str {
        &self.state.token
    }

    pub fn bind_address(&self) -> SocketAddr {
        self.bind_address
    }

    pub fn router(&self) -> Router {
        Router::new()
            .route("/v1/command", post(execute_command))
            .route("/v1/query", post(run_query))
            .with_state(self.state.clone())
    }

    pub async fn serve(self) -> Result<(), HttpAdapterError> {
        let listener = tokio::net::TcpListener::bind(self.bind_address)
            .await
            .map_err(|source| HttpAdapterError::Bind {
                address: self.bind_address,
                source,
            })?;
        axum::serve(listener, self.router())
            .await
            .map_err(HttpAdapterError::Serve)
    }
}

fn generate_token() -> Result<String, HttpAdapterError> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| HttpAdapterError::EntropyUnavailable)?;
    let mut token = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use fmt::Write;
        write!(token, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(token)
}

async fn execute_command(
    State(state): State<HttpState>,
    headers: HeaderMap,
    Json(command): Json<Command>,
) -> Result<Json<CommandResult>, ApiError> {
    authorize(&state, &headers)?;
    let result = state
        .application
        .lock()
        .map_err(|_| ApiError::unavailable())?
        .execute(command)
        .map_err(ApiError::from)?;
    Ok(Json(result))
}

async fn run_query(
    State(state): State<HttpState>,
    headers: HeaderMap,
    Json(query): Json<Query>,
) -> Result<Json<QueryResult>, ApiError> {
    authorize(&state, &headers)?;
    let result = state
        .application
        .lock()
        .map_err(|_| ApiError::unavailable())?
        .query(query)
        .map_err(ApiError::from)?;
    Ok(Json(result))
}

fn authorize(state: &HttpState, headers: &HeaderMap) -> Result<(), ApiError> {
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    if host != Some(state.authority.as_ref()) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "invalid_host",
            "Host does not match the loopback API endpoint",
        ));
    }

    if let Some(origin) = headers.get(header::ORIGIN)
        && origin.to_str().ok() != Some(state.origin.as_ref())
    {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "invalid_origin",
            "Origin does not match the loopback API endpoint",
        ));
    }

    let supplied_token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    if supplied_token != Some(state.token.as_ref()) {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "A valid bearer token is required",
        ));
    }
    Ok(())
}

#[derive(Debug, Serialize)]
struct ApiErrorBody {
    code: &'static str,
    message: String,
}

struct ApiError {
    status: StatusCode,
    body: ApiErrorBody,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            body: ApiErrorBody {
                code,
                message: message.into(),
            },
        }
    }

    fn unavailable() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "adapter_unavailable",
            "HTTP application state is unavailable",
        )
    }
}

impl From<DomainError> for ApiError {
    fn from(error: DomainError) -> Self {
        let status = match &error {
            DomainError::NotFound => StatusCode::NOT_FOUND,
            DomainError::RevisionConflict { .. }
            | DomainError::IdempotencyConflict
            | DomainError::AlreadyExists
            | DomainError::SiblingKeyConflict
            | DomainError::SiblingPositionConflict
            | DomainError::PrimaryResourceConflict
            | DomainError::ResourceBindingConflict => StatusCode::CONFLICT,
            DomainError::Storage(_)
            | DomainError::Io(_)
            | DomainError::MigrationChecksum { .. }
            | DomainError::MigrationBusy
            | DomainError::BackupBusy
            | DomainError::BackupIntegrity
            | DomainError::BackupDestinationExists
            | DomainError::RestoreValidation { .. } => StatusCode::INTERNAL_SERVER_ERROR,
            _ => StatusCode::BAD_REQUEST,
        };
        let code = error.code();
        Self::new(status, code, error.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(self.body)).into_response()
    }
}
