# Architecture Overview (arc42)

This document describes the architecture of the **Octo AI Agent Solution Framework** following the [arc42](https://arc42.org/) architecture documentation standard. It serves as the master blueprint, linking to detailed deep-dives for specific components.

---

## 1. Introduction and Goals

The Octo AI Agent Framework provides a production-ready, extensible foundation for building AI-agentic solutions, with a strong focus on enterprise readiness and SAP ecosystem integration.

### Requirements Overview
- Support multi-user, multi-tenant agent interactions via Web UI and Slack.
- Execute AI-generated code securely in isolated environments.
- Provide a modular architecture allowing custom tools, skills, and LLM integrations.
- Seamlessly deploy to enterprise cloud environments like SAP BTP Cloud Foundry.

### Quality Goals
1.  **Security & Isolation**: Strict sandboxing of agent execution and tenant data isolation.
2.  **Extensibility**: Frictionless integration of custom tools (via MCP) and domain knowledge (via Skills).
3.  **Portability**: Ability to run locally (Docker/Podman) or in the cloud (ephemeral filesystems with Object Store backups).

### Stakeholders
- **AI Solution Builders**: Developers creating custom agents using this framework.
- **Enterprise Architects**: Ensuring the system meets corporate security and deployment standards.
- **End Users**: Interacting with the agent via Slack or the Web UI to solve engineering tasks.

---

## 2. Architecture Constraints

### Technical Constraints
- **Runtime**: Node.js (v18+).
- **Execution Isolation**: Must use Docker or Podman for secure sandboxing.
- **Cloud Native**: Must support ephemeral filesystems (requiring S3/Object Store for persistent state).
- **SAP Integration**: Must natively support SAP XSUAA (Auth) and SAP AI Core (Generative AI models).

### Organizational Constraints
- Developed as a monorepo utilizing npm workspaces.

---

## 3. System Scope and Context

### Business Context
The system acts as a collaborative AI peer. Users interact with the agent via chat interfaces to accomplish software engineering tasks, data analysis, or system troubleshooting.

### Technical Context
- **External Systems**: 
  - LLM Providers (SAP AI Core, OpenAI, Anthropic).
  - External MCP Servers (providing specialized tools).
  - SAP BTP Services (XSUAA, Destination, Connectivity).
  - Chat Platforms (Slack).
- **Interfaces**: REST/HTTP, Server-Sent Events (SSE) for streaming, WebSocket (Slack Socket Mode).

---

## 4. Solution Strategy

To achieve the quality goals, the system relies on a **Modular Monorepo Architecture**:
1.  **Decoupled Intelligence**: The AI reasoning and tool orchestration are completely separated (`core-agent`) from the hosting backend (`core-service`).
2.  **Workspace Isolation**: State is heavily partitioned into "Workspaces" and "Sessions" on the filesystem, making access control and state synchronization explicit.
3.  **Sandbox Pattern**: All dangerous actions (reading/writing files, executing shell commands) are delegated to an `Executor` interface that runs inside a restricted Docker/Podman container.
4.  **Protocol-Driven Extensibility**: Using the Model Context Protocol (MCP) to decouple tools from the agent runtime.

---

## 5. Building Block View

### Level 1: System Context
The system is divided into three primary packages:

```text
+-----------------------------------------------------------+
| User Interface (web-app-corp / web-ui-corp)               |
+----------------------------+------------------------------+
                             | SSE / REST
                             v
+-----------------------------------------------------------+
| core-service (The Host)                                   |
| +------------------------+   +--------------------------+ |
| | Workspace Management   |   | Multi-Channel Adapters   | |
| +------------------------+   +--------------------------+ |
|             |                          |                  |
|             +------------+-------------+                  |
|                          |                                |
|                          v                                |
|            +----------------------------+                 |
|            | core-agent (The Brain)     |                 |
|            +----------------------------+                 |
|                          |                                |
+--------------------------|--------------------------------+
                           |
            +--------------v--------------+
            | Sandbox (Docker / Podman)   |
            | +-------------------------+ |
            | | Executor (bash, edit)   | |
            | +-------------------------+ |
            +-----------------------------+
```

1.  **`core-agent` (The Brain)**: Platform-agnostic library handling the LLM loop, context window management, and tool execution bridging. 
    *   *See Deep Dive:* [Core Agent Architecture](./CORE_AGENT.md)
2.  **`core-service` (The Host)**: Multi-tenant backend managing workspaces, chat session state, background events, persistence, and adapters for UI/Slack.
    *   *See Deep Dive:* [Core Service & Workspaces](./CORE_SERVICE.md)
3.  **`web-app-corp` & `web-ui-corp` (The Interface)**: Frontend components and reference application providing a rich user experience with streaming updates.
    *   *See Deep Dive:* [UI & Frontend Adapters](./UI_AND_ADAPTERS.md)

---

## 6. Runtime View

### The Agentic Loop Scenario
When a user sends a message, the following sequence occurs:

```text
User          core-service        core-agent         Sandbox           LLM
 |                 |                  |                 |               |
 |---- message --->|                  |                 |               |
 |                 |---- run() ------>|                 |               |
 |                 |                  |---- prompt ---->|               |
 |                 |                  |                 |<--- tool ---->|
 |                 |                  |--- exec tool -->|               |
 |                 |                  |<-- result ------|               |
 |<--- streaming --|                  |                 |               |
 |                 |<--- final msg ---|                 |               |
 |<--- response ---|                  |                 |               |
```

1.  **Routing (`core-service`)**: Request arrives via HTTP or Slack. The service identifies the user, workspace, and session.
2.  **Hydration**: Session history (`context.jsonl`) and workspace memories are loaded.
3.  **Orchestration (`core-agent`)**: The message is passed to the `CoreAgent`. The agent invokes the LLM.
4.  **Tool Execution (`Sandbox`)**: If the LLM requests a tool (e.g., `bash`), the `core-agent` passes the request to the `Executor`. The command runs in an isolated Docker container.
5.  **Streaming**: Throughout this process, SSE events (thoughts, tool logs) are streamed back to the UI.
6.  **Persistence**: Once the LLM loop concludes, the final state is flushed to the `WorkspaceStore`.

---

## 7. Deployment View

Octo is designed to run in two primary modes:

```text
Local Deployment                 |  SAP BTP (Cloud Foundry)
---------------------------------+---------------------------------
                                 |
+-----------------------+        |      +-----------------------+
| Web Browser           |        |      | Web Browser           |
+-----------+-----------+        |      +-----------+-----------+
            |                    |                  |
            v                    |                  v
+-----------+-----------+        |      +-----------+-----------+
| Host OS (Node.js)     |        |      | AppRouter             |
| +-------------------+ |        |      +-----------+-----------+
| | core-service      | |        |                  |
| +---------+---------+ |        |                  v
|           |           |        |      +-----------+-----------+
| |         v           |        |      | core-service (Node)   |
| +---------+---------+ |        |      +-----------+-----------+
| | Docker Container  | |        |            |           |
| +-------------------+ |        |            v           v
+-----------+-----------+        |      +-----+-----+ +-----+-----+
            |                    |      | Object    | | SAP AI    |
            v                    |      | Store     | | Core      |
      Local Disk                 |      +-----------+ +-----------+
```

### Local Development
- **Node.js** running on the host machine.
- **Docker Engine** running locally to spin up sandbox containers.
- **Local Filesystem** used for workspace and session persistence.

### Enterprise Cloud (SAP BTP Cloud Foundry)
- **AppRouter**: Handles inbound traffic and XSUAA authentication.
- **Node.js Buildpack**: Runs the `core-service`.
- **Sandbox Management**: Sandboxes are either managed externally or execution is routed to secure runtime environments.
- **Persistence Mirroring**: Because CF filesystems are ephemeral, the `ObjectStoreMirror` syncs workspace state to an S3 bucket at the end of every run.
- *See Deep Dive:* [SAP Ecosystem Integration](./SAP_INTEGRATION.md)

---

## 8. Cross-cutting Concepts

### Security and Isolation
All file modifications and command executions happen within the `artifacts/` folder of a specific workspace. Sandboxes prevent the agent from accessing host processes or neighboring workspaces.
- *See Deep Dive:* [Sandboxing & Execution](./SANDBOXING.md)

### Extensibility
The framework allows adding primitive TypeScript tools directly to `core-agent`, connecting external MCP servers via standard transport layers (stdio/SSE), and injecting domain knowledge via Markdown-based "Skills".
- *See Deep Dive:* [Extensibility: Tools, MCP & Skills](./EXTENDING.md)

### State Management
State is managed hierarchically: Global -> Workspace -> Session. State is stored natively as JSONL (for chat logs/context) and Markdown (for Memory and Skills) to allow easy human inspection and Git tracking if desired.

---

## 9. Architecture Decisions

- **ADR-001: Filesystem-First Persistence.** *Decision*: Use local files (JSONL/MD) instead of a relational database for core agent state. *Rationale*: Allows easy debugging, integrates perfectly with LLM context windows, and enables simple Object Store syncing for cloud deployments.
- **ADR-002: Docker/Podman for Sandboxing.** *Decision*: Agent tools run inside containers rather than raw host processes. *Rationale*: Prevents accidental deletion of host files and isolates execution environments across tenants.
- **ADR-003: Model Context Protocol (MCP).** *Decision*: Adopt MCP for custom tools. *Rationale*: Standardizes tool integration, allowing builders to reuse community MCP servers instead of writing custom wrappers.

---

## 10. Quality Requirements

- **Reliability**: The agent loop must handle tool failures gracefully and retry or report errors to the user.
- **Security**: A compromised agent prompt (Prompt Injection) must not result in host system compromise. The sandbox guarantees this boundary.
- **Maintainability**: Clear separation of concerns between UI, Service, and Agent allows teams to iterate on the UI without understanding LLM orchestration, and vice versa.

---

## 11. Risks and Technical Debts

- **LLM Hallucinations**: Agents can attempt to use tools incorrectly or fabricate file paths. *Mitigation*: The `core-agent` tool layer enforces strict path validation within the sandbox boundaries.
- **Sandbox Escapes**: Docker misconfiguration could lead to host access. *Mitigation*: Recommend Podman (rootless) and disabling networking in production sandbox environments.
- **Ephemeral State Loss**: In Cloud Foundry, if the application crashes before the `ObjectStoreMirror` flushes, the last interaction may be lost. *Mitigation*: Implementing frequent background snapshots.

---

## 12. Glossary

- **Workspace**: A collaborative boundary containing members, specific settings, artifacts, and a shared pool of Agent Skills.
- **Session**: A single threaded conversation with an agent within a Workspace.
- **Skill**: A markdown file (`SKILL.md`) providing specific instructions or domain knowledge injected into the agent's system prompt.
- **Sandbox/Executor**: The isolated environment (usually a container) where the agent executes tools like `bash` and `edit`.
- **MCP (Model Context Protocol)**: An open standard for connecting AI models to external tools and data sources.
