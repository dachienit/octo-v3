# Core Agent Deep Dive

The `core-agent` is the core logic for the Octo AI Agent. It handles the "agentic loop," tool execution, and context management.

## The `CoreAgent` Class

The `CoreAgent` class (found in `core-agent/src/agent.ts`) is the main entry point for running an agent session. Each instance of `CoreAgent` is dedicated to a single session/channel.

### Key Responsibilities:
- **Session Persistence**: Uses `SessionManager` to read/write `context.jsonl`.
- **Agentic Loop**: Wraps the `@earendil-works/pi-agent-core` agent to handle the interaction with the LLM.
- **Tool Management**: Registers primitive tools and handles their execution via the sandbox.
- **Context Synthesis**: Combines system prompts, chat history, attachments, and "Memory" files into a cohesive prompt for the LLM.
- **Event Handling**: Emits events (tool starts, tool ends, thinking, messages) that the hosting service can stream to the user.

## Skills

Skills are high-level guidance for the agent, typically stored in `SKILL.md` files. They provide the agent with specialized knowledge or instructions for specific tasks.

- **Workspace Skills**: Located in the workspace's `skills/` directory. These are available to all sessions in the workspace.
- **Session Skills**: Located in the session's `skills/` directory. These are specific to a single session.
- **Loading**: Skills are loaded and formatted into the system prompt using `loadSkills` and `formatSkillsForPrompt`.

## Tools

Octo comes with a set of "Primitive Tools" that allow the agent to interact with the environment:

1.  **`read`**: Reads files from the workspace artifacts.
2.  **`write`**: Writes or overwrites files in the workspace artifacts.
3.  **`edit`**: Performs surgical edits (search and replace) on files.
4.  **`bash`**: Executes shell commands inside the sandbox.
5.  **`attach`**: Allows the agent to "upload" a file from the sandbox back to the chat interface (e.g., a generated report or image).

### Tool Execution Context
All file-system tools (`read`, `write`, `edit`, `bash`) resolve paths relative to the `artifacts/` directory of the workspace. This ensures the agent can only touch files within its designated sandbox.

## Memory System

Octo implements a simple but effective "Memory" system using `MEMORY.md` files.

- **Global Workspace Memory**: `workspaces/<ws-id>/MEMORY.md`
- **Channel-Specific Memory**: `workspaces/<ws-id>/sessions/<session-id>/MEMORY.md`

These files are injected into the system prompt as "Working Memory," allowing the user or the agent itself to persist important facts across interactions without relying solely on chat history.

## The Run Loop

When `core-agent.run()` is called:
1.  **Syncing**: It syncs any "offline" messages from `log.jsonl` (e.g., messages that arrived while the service was down).
2.  **Prompt Building**: It constructs a timestamped user message, including any attachments.
3.  **LLM Call**: It triggers the agent loop.
4.  **Tool Calls**: If the LLM requests a tool, `CoreAgent` executes it (using the sandbox executor if necessary) and feeds the result back to the LLM.
5.  **Final Response**: Once the LLM provides a final message, the loop completes and returns the result.
