import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { SandboxConfig } from "./sandbox.js";

export interface CoreAgentOptions {
	sandboxConfig: SandboxConfig;
	/** Host path to the channel's session directory (contains context.jsonl, MEMORY.md, etc.) */
	channelDir: string;
	/** Auth JSON path used unless a run provides a user-specific path */
	authFilePath?: string;
	/** User id owning this agent run and any delegated worker auth */
	userId?: string;
	/** Root directory containing per-user service data */
	usersRoot?: string;
	/** Enable ACP-compatible delegated worker agents */
	agentWorkersEnabled?: boolean;
	/** Enable the `task` tool (in-process nested subagents). Defaults to enabled. */
	subagentsEnabled?: boolean;
	/** Additional tools beyond the primitive set */
	extraTools?: AgentTool<any>[];
	/**
	 * Primitive tool names the workspace has enabled (`settings.tools.enabled`).
	 * Omitted means "never configured" and falls back to the catalog defaults.
	 * Does not apply to `extraTools`, which MCP gates on its own.
	 */
	enabledTools?: string[];
}

export interface CoreAgentRunInput {
	/** Message text from the user */
	text: string;
	/** Slack/adapter timestamp of this message — used to exclude it from log sync */
	ts?: string;
	/** Display name of the user */
	userName?: string;
	/** Attachments with relative paths under the workspace */
	attachments?: Array<{ local: string }>;
	/**
	 * Files and folders the user pointed at with `@`, as paths relative to the
	 * workspace. These already exist in the workspace, so they are passed as
	 * pointers the agent may read on demand — never as inlined content — and a
	 * mention can be a directory, which an attachment never is.
	 */
	mentions?: Array<{ local: string; type: "file" | "directory" }>;
	/**
	 * Skills the user invoked explicitly (the `/name` mechanic in the composer), as the
	 * workspace-relative path of each SKILL.md. Like mentions these are pointers, but
	 * unlike mentions they are an instruction: the agent is expected to read them and
	 * follow them for this request rather than decide whether they are relevant.
	 */
	skills?: Array<{ name: string; local: string }>;
	/** Full system prompt for this run */
	systemPrompt: string;
	/** User-specific auth JSON path for this run */
	authFilePath?: string;
	/**
	 * Permission mode for this run. "plan" restricts the agent to read-only tools
	 * until it calls `exit_plan_mode`. Omitted leaves the session's current mode
	 * unchanged.
	 */
	mode?: "default" | "plan";
	/**
	 * IYH1HC add: per-run model override. When present, the agent runs this model
	 * (resolved via pi-ai getModel, falling back to a stub) and uses `apiKey`
	 * instead of the env/auth-file key. Absent → legacy env-driven behavior.
	 */
	model?: { provider: string; modelId: string; apiKey?: string; baseUrl?: string; apiType?: string };
	/** Called by the attach tool — path is already translated to host path */
	uploadFile?: (path: string, title?: string) => Promise<void>;
	/** Per-run event callbacks */
	events?: CoreAgentEventHandlers;
}

export interface CoreAgentEventHandlers {
	onToolStart?: (toolName: string, label: string, args: Record<string, unknown>, toolCallId?: string) => void;
	onToolEnd?: (
		toolName: string,
		label: string | undefined,
		args: Record<string, unknown>,
		durationMs: number,
		resultText: string,
		isError: boolean,
		toolCallId?: string,
	) => void;
	onToolUpdate?: (
		toolName: string,
		label: string | undefined,
		args: Record<string, unknown>,
		resultText: string,
		toolCallId?: string,
	) => void;
	onMessage?: (text: string) => void;
	onThinking?: (text: string) => void;
	onCompactionStart?: (reason: string) => void;
	onCompactionEnd?: (result?: { tokensBefore: number }, aborted?: boolean) => void;
	onRetry?: (attempt: number, maxAttempts: number, errorMessage?: string) => void;
	onTurnStart?: () => void;
	onTurnEnd?: () => void;
	onBlockStart?: (blockId: string, kind: "text" | "thinking") => void;
	onBlockDelta?: (blockId: string, kind: "text" | "thinking", delta: string) => void;
	onBlockEnd?: (blockId: string, kind: "text" | "thinking", content: string) => void;
	/** Model finished composing a tool call (args complete, execution not started yet). */
	onToolCall?: (toolCallId: string, toolName: string, args: Record<string, unknown>) => void;
	/** Authoritative usage after each assistant message (one per LLM call). */
	onUsage?: (usage: CoreAgentRunResult["usage"], stopReason?: string, model?: { provider: string; id: string }) => void;
}

export interface CoreAgentRunResult {
	stopReason: string;
	errorMessage?: string;
	/** Text of the last assistant message, if any */
	lastAssistantText?: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			total: number;
		};
	};
}
