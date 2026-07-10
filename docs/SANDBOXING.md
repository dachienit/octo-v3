# Sandboxing & Execution

Security is a primary concern when allowing an AI agent to execute code. Octo uses a modular "Sandbox" architecture to isolate the agent's operations from the host system.

## The `Executor` Interface

The `Executor` interface (defined in `core-agent/src/sandbox.ts`) abstracts the execution environment. It provides methods for:
- `exec()`: Running a shell command.
- `readFile()`, `writeFile()`, `deleteFile()`: Basic file operations.
- `exists()`, `stat()`, `ls()`: Directory and file inspection.
- `getWorkspacePath()`: Translating paths between the host and the sandbox.

## Sandbox Types

Octo supports three types of sandboxes, configurable via the `--sandbox` flag when starting the `core-service`.

### 1. Host Sandbox (`--sandbox=host`)
- **Isolation**: Minimal. Commands run directly on the host machine.
- **Use Case**: Local development or trusted environments where containerization is not available.
- **Caution**: The agent has full access to the host's filesystem and network (within the limits of the process user).

### 2. Docker Sandbox (`--sandbox=docker[:container-name]`)
- **Isolation**: High. Commands run inside a Docker container.
- **Mechanism**: Octo uses `docker exec` to run commands.
- **Workspace Mounting**: The `data/` directory (or specific workspace folders) is typically mounted into the container.
- **Container Lifecycle**:
    - **Global Container**: If a container name is provided, all workspaces share that container.
    - **Per-Workspace Containers**: If no name is provided, Octo can manage a separate container for each workspace, starting and stopping them based on activity.

### 3. Podman Sandbox (`--sandbox=podman[:container-name]`)
- **Isolation**: High. Similar to Docker but using Podman.
- **Advantage**: Rootless execution, which is often preferred in enterprise or restricted environments.

## Sandbox Configuration in Workspaces

A workspace's `workspace.json` can specify a `sandbox` configuration, including a custom Docker/Podman image. This allows you to provide the agent with a pre-configured environment containing specific tools, compilers, or libraries.

```json
{
  "id": "ws_xyz",
  "sandbox": {
    "image": "my-custom-agent-runtime:latest"
  }
}
```

## Security Best Practices

1.  **Use Containerization**: Always use `docker` or `podman` sandboxes in production.
2.  **Least Privilege**: Run the `core-service` and the sandbox containers with non-root users.
3.  **Network Isolation**: Configure your container runtime to restrict the sandbox's network access (e.g., using `--network none` or a restricted bridge).
4.  **Resource Limits**: Set CPU and memory limits on the sandbox containers to prevent "denial of service" from accidental (or intentional) resource-intensive commands.
5.  **ReadOnly Root**: Where possible, run the container with a read-only root filesystem, mounting only the `artifacts/` and `tmp/` directories as writable.
