# Octo AI Agent Solution Framework

Welcome to the documentation for the Octo AI Agent Solution Framework. This project is a comprehensive, production-ready foundation for building AI-agentic solutions, particularly suited for enterprise environments and SAP ecosystems.

## For AI Agent Solution Builders

If you are looking to build your own AI agent, this project provides:
- **Modular Core**: A decoupled `core-agent` that manages the LLM interaction, tools, and skills.
- **Robust Service Layer**: A `core-service` that handles multi-user workspaces, session persistence, and multi-channel communication (Slack, Web).
- **Secure Sandboxing**: Built-in support for running agent code in isolated environments (Docker/Podman).
- **Enterprise Ready**: Designed for SAP BTP, with native support for SAP AI Core, ABAP, and CAP.
- **Extensible**: Support for the Model Context Protocol (MCP), custom tools, and skills.

## Documentation Index

Explore the following guides to understand and build with Octo:

0.  [**Getting Started**](./docs/GETTING_STARTED.md)
    Set up Octo locally and build your first solution.
1.  [**Architecture Overview (arc42)**](./docs/ARCHITECTURE.md)
    Understand the high-level design, component interaction, and data flow mapped to the arc42 standard.
2.  [**Core Agent Deep Dive**](./docs/CORE_AGENT.md)
    Learn how the agentic loop works, how skills are loaded, and how tools are executed.
3.  [**Core Service & Workspaces**](./docs/CORE_SERVICE.md)
    Discover how the backend manages multiple users, persistent workspaces, and sessions.
4.  [**Sandboxing & Execution**](./docs/SANDBOXING.md)
    Details on how the agent safely executes code in isolated containers.
5.  [**Extensibility: Tools, MCP & Skills**](./docs/EXTENDING.md)
    Guide on adding your own capabilities to the agent.
6.  [**SAP Ecosystem Integration**](./docs/SAP_INTEGRATION.md)
    How Octo integrates with SAP AI Core, ABAP, and CAP.
7.  [**UI & Frontend Adapters**](./docs/UI_AND_ADAPTERS.md)
    Overview of the web interface and how the service adapts to different clients.

---

## Project Structure

- `core-agent/`: The heart of the agent. LLM orchestration, tool management, and skill loading.
- `core-service/`: The backend host. Multi-channel support (SSE/Slack), workspace management, and persistence.
- `web-ui-corp/`: Reusable frontend components and adapters.
- `web-app-corp/`: The main web application.
- `templates/`: Pre-configured workspace templates for specific scenarios (e.g., SAP ABAP, SAP CAP).
