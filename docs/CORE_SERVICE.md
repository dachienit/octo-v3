# Core Service & Workspaces

The `core-service` is the multi-tenant backend for the Octo framework. It manages the lifecycle of workspaces, sessions, and agent instances.

## Workspace Management

A "Workspace" in Octo is more than just a folder; it's a collaborative environment with its own settings, members, and resources.

### `WorkspaceStore`
The `WorkspaceStore` (in `core-service/src/workspaces.ts`) is responsible for:
- **CRUD Operations**: Creating, listing, and updating workspaces.
- **Templates**: Initializing new workspaces from templates (e.g., SAP CAP, SAP ABAP) which include pre-defined skills and settings.
- **Access Control**: Managing workspace members and their roles (owner, admin, editor, viewer).
- **Session Lifecycle**: Creating and retrieving sessions within a workspace.

### Workspace Structure
Each workspace directory contains:
- `workspace.json`: Metadata (name, template, sandbox image).
- `members.json`: List of users and their roles.
- `settings.json`: Configuration for tools, connectors, and MCP servers.
- `artifacts/`: The agent's working directory.
- `skills/`: Workspace-level skills.
- `events/`: Scheduled events/reminders.

## Multi-Channel Support

Octo is designed to be accessible from multiple platforms.

### HTTP / SSE Adapter
The web interface interacts with the service via a set of HTTP endpoints and Server-Sent Events (SSE).
- **Endpoints**: `/api/workspaces`, `/api/sessions`, `/api/run`, etc.
- **SSE**: Used to stream agent thoughts and tool execution progress in real-time.

### Slack Adapter
A first-class Slack adapter allows the agent to function as a Slack bot.
- **Socket Mode**: Connects to Slack via Socket Mode for easy setup without public endpoints.
- **Context Handling**: Maps Slack threads and channels to Octo sessions.
- **Rich Interaction**: Supports Slack-specific features like typing indicators and threaded replies.

## Sandboxing Mechanism

The service ensures security by running agent code in isolated environments.
- **Managed Sandboxes**: For Docker and Podman, the service can manage per-workspace containers.
- **Lifecycle**: Containers are started when needed and cleaned up after a period of idleness (via `SandboxManager`).

## Persistence & Object Store

By default, Octo uses the local filesystem for persistence. However, for cloud deployments (like SAP BTP), where local storage is ephemeral, it supports an **Object Store Mirror**.

### `ObjectStoreMirror`
- **Backup/Restore**: Automatically syncs the local workspace tree to an S3-compatible bucket.
- **Snapshots**: Takes snapshots of workspace/session data after each run or at regular intervals.
- **Cloud Foundry Integration**: Hydrates credentials from `VCAP_SERVICES` (e.g., from an SAP Object Store service binding).

## Event System

The service includes a background worker (`createEventsWatcher` / `createWorkspaceEventsWatcher`) that monitors the `events/` directory in each workspace.
- **Reminders**: Agents can "schedule" future wake-ups by writing event files.
- **Execution**: When an event's time arrives, the service triggers a background run of the agent in the specified session.
