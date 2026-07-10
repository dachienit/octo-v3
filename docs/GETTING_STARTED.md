# Getting Started for Solution Builders

This guide will help you set up the Octo framework for local development and start building your own agentic solutions.

## Prerequisites

- **Node.js**: v18 or higher.
- **Docker or Podman**: Required for sandboxed code execution.
- **LLM API Key**: You'll need an API key from a provider like OpenAI, Anthropic, or Google.

## Installation

1.  **Clone the Repository**:
    ```bash
    git clone <repository-url>
    cd octo-v2
    ```

2.  **Install Dependencies**:
    ```bash
    npm install
    ```

3.  **Configure Environment Variables**:
    Create a `.env` file in the root directory (or in `core-service/`) with the following variables:
    ```env
    LLM_PROVIDER=openai
    LLM_MODEL=gpt-4o
    LLM_API_KEY=your-api-key
    # Optional: SAP AI Core configuration
    # AICORE_SERVICE_KEY=...
    ```

## Running the Project

### 1. Start the Backend (Core Service)
The backend manages workspaces and agent sessions. Run it with a data directory and a sandbox configuration.

```bash
cd core-service
npm run dev -- --sandbox=docker ./data
```
*Note: Replace `docker` with `host` if you don't want to use containerization during initial testing.*

### 2. Start the Frontend (Web App)
In a new terminal, start the development server for the web application.

```bash
cd web-app-corp
npm run dev
```

The application should now be accessible at `http://localhost:5173`.

## Building Your First Solution

### 1. Create a Workspace
Open the web interface and create a new workspace. You can choose a template (like SAP CAP) to get started with pre-configured skills.

### 2. Add a Custom Skill
Navigate to your workspace directory (e.g., `./core-service/data/workspaces/ws_abc/skills/`) and create a new folder with a `SKILL.md` file. The agent will immediately pick up this new knowledge.

### 3. Register a New Tool
To add a custom tool, you can modify `core-agent/src/tools/index.ts` or add an MCP server to your workspace settings. See the [Extending Guide](./EXTENDING.md) for details.

## Deployment to SAP BTP

For production deployment, Octo is designed for SAP BTP.
1.  **Build the MTA**: `mbt build`
2.  **Deploy**: `cf deploy mta_archives/octo_1.0.0.mtar`

Refer to the [SAP Ecosystem Integration Guide](./SAP_INTEGRATION.md) for detailed deployment and configuration steps.
