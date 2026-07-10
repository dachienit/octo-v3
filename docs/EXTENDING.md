# Extensibility: Tools, MCP & Skills

Octo is designed to be highly extensible, allowing you to tailor the agent's capabilities to your specific domain.

## 1. Custom Tools (Native)

You can add new primitive tools to the `core-agent`. A tool is defined by a schema (parameters) and an execution function.

### Example Tool Definition:
```typescript
import { Type } from "@sinclair/typebox";
import { AgentTool } from "@earendil-works/pi-agent-core";

export const myCustomTool: AgentTool = {
  name: "get_weather",
  description: "Get the current weather for a location",
  parameters: Type.Object({
    location: Type.String({ description: "The city and country" }),
  }),
  async execute(toolCallId, { location }) {
    const data = await fetchWeather(location);
    return {
      content: [{ type: "text", text: `The weather in ${location} is ${data.temp}°C.` }],
    };
  },
};
```

To register it, add it to the `extraTools` array when initializing `CoreAgent`.

## 2. Model Context Protocol (MCP)

Octo supports the **Model Context Protocol (MCP)**, allowing you to integrate with external tool servers.

### Configuring MCP Servers
You can configure MCP servers globally or per workspace in the workspace settings.

```json
{
  "mcp": {
    "servers": [
      {
        "name": "sqlite-tools",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-sqlite", "--db", "/workspace/artifacts/db.sqlite"]
      }
    ]
  }
}
```

### Supported Transports:
- **`stdio`**: For local command-line tools.
- **`sse`**: For remote servers via Server-Sent Events.

Octo automatically discovers tools provided by the MCP server and makes them available to the agent.

## 3. Custom Skills

Skills are the easiest way to extend the agent's knowledge. Simply create a new directory under `skills/` in your workspace and add a `SKILL.md` file.

### Skill Anatomy:
- **`SKILL.md`**: The main content. Use it to provide guidance, rules, and examples.
- **`index.json`** (Optional): Metadata for the skill (name, version, dependencies).

The agent will automatically "see" these skills in its system prompt and can use them to guide its behavior.

## 4. Extensions (Service Level)

For more complex integrations that require access to the service infrastructure (like authentication, storage, or external APIs), you can use the Extension system.

### Example: SAP AI Core Provider
The `sap-ai-core-provider.ts` in `core-service` is an example of an extension that:
1.  Registers a custom LLM provider.
2.  Handles OAuth2 authentication with SAP BTP.
3.  Injects the necessary headers and base URL for SAP AI Core.

Extensions are typically registered during the service bootstrap in `main.ts` or through the `CoreAgentOptions`.
