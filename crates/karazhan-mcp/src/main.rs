use std::{env, error::Error, io, path::PathBuf};

use karazhan_core::{
    Database, DomainError,
    application::{Application, Command, Query, SharedApplication, share_application},
};
use rmcp::{
    ErrorData as McpError, ServerHandler, ServiceExt,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{Implementation, ServerCapabilities, ServerConfig},
    tool, tool_handler, tool_router,
    transport::stdio,
};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug, Deserialize, JsonSchema)]
struct ContractRequest {
    request: Value,
}

#[derive(Clone)]
struct KarazhanMcp {
    application: SharedApplication,
    #[allow(dead_code)]
    tool_router: ToolRouter<Self>,
}

#[tool_router]
impl KarazhanMcp {
    fn new(application: SharedApplication) -> Self {
        Self {
            application,
            tool_router: Self::tool_router(),
        }
    }

    #[tool(
        name = "karazhan_command",
        description = "Execute one Karazhan shared application command."
    )]
    async fn command(
        &self,
        Parameters(arguments): Parameters<ContractRequest>,
    ) -> Result<String, McpError> {
        let command = serde_json::from_value::<Command>(arguments.request)
            .map_err(|error| invalid_contract("invalid_command", error.to_string()))?;
        let result = self
            .application
            .lock()
            .map_err(|_| unavailable())?
            .execute(command)
            .map_err(domain_error)?;
        serde_json::to_string(&result)
            .map_err(|error| McpError::internal_error(error.to_string(), None))
    }

    #[tool(
        name = "karazhan_query",
        description = "Run one Karazhan shared application query."
    )]
    async fn query(
        &self,
        Parameters(arguments): Parameters<ContractRequest>,
    ) -> Result<String, McpError> {
        let query = serde_json::from_value::<Query>(arguments.request)
            .map_err(|error| invalid_contract("invalid_query", error.to_string()))?;
        let result = self
            .application
            .lock()
            .map_err(|_| unavailable())?
            .query(query)
            .map_err(domain_error)?;
        serde_json::to_string(&result)
            .map_err(|error| McpError::internal_error(error.to_string(), None))
    }
}

#[tool_handler]
impl ServerHandler for KarazhanMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build()).with_server_info(
            Implementation::new("karazhan-mcp", env!("CARGO_PKG_VERSION")),
        )
    }
}

fn invalid_contract(code: &'static str, message: String) -> McpError {
    McpError::invalid_params(message, Some(json!({ "code": code })))
}

fn unavailable() -> McpError {
    McpError::internal_error(
        "MCP application state is unavailable",
        Some(json!({ "code": "adapter_unavailable" })),
    )
}

fn domain_error(error: DomainError) -> McpError {
    let code = error.code();
    McpError::invalid_params(error.to_string(), Some(json!({ "code": code })))
}

async fn run() -> Result<(), Box<dyn Error>> {
    let database_path = env::var_os("KARAZHAN_DATABASE_PATH")
        .map(PathBuf::from)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "KARAZHAN_DATABASE_PATH must point to the product database",
            )
        })?;
    let application = share_application(Application::new(Database::open(database_path)?));
    let service = KarazhanMcp::new(application).serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("karazhan-mcp: {error}");
        std::process::exit(1);
    }
}
