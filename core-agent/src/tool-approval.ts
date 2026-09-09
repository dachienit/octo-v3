//IYH1HC tool approval add
/**
 * Pending tool-approval registry.
 *
 * A workspace no longer hides the tools it has turned off — the model sees all of
 * them, and calling a tool that is off parks the agent loop here until a human
 * answers. The park works because pi-agent-core `await`s `beforeToolCall` and
 * hands it the run's abort signal (see `agent-loop.js` `prepareToolCall`), so a
 * promise held open here suspends that one tool call and nothing else: no
 * polling, no busy loop, and the loop re-checks `signal.aborted` the moment the
 * await returns.
 *
 * Every exit path — answered, timed out, aborted — resolves the promise and
 * fires `resolved`. That is deliberate and load-bearing: the resolved event is
 * what closes the approval card in the UI and what keeps `trail.jsonl` from
 * replaying a request that never ends.
 *
 * Nothing here knows about HTTP, SSE or SAP. The host supplies two callbacks and
 * calls `resolve()` when its user answers.
 */

/** What a human may answer. */
export type ToolApprovalDecision = "once" | "session" | "denied";

/** How a wait ended — a decision, or one of the two ways it can end without one. */
export type ToolApprovalVerdict = ToolApprovalDecision | "timeout" | "aborted";

export interface ToolApprovalRequest {
	toolCallId: string;
	toolName: string;
	/** The `label` argument every tool carries; what the UI shows as the caption. */
	label?: string;
	args: Record<string, unknown>;
}

export interface ToolApprovalNotifier {
	request(request: ToolApprovalRequest): void;
	resolved(toolCallId: string, toolName: string, verdict: ToolApprovalVerdict): void;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Waiting holds the turn's SSE response open, so an unanswered card would pin a
 * socket and the channel's run-queue slot forever. Read lazily so a deployment
 * can shorten it without a rebuild.
 */
export function resolveApprovalTimeoutMs(): number {
	const raw = Number(process.env.CORE_AGENT_TOOL_APPROVAL_TIMEOUT_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

interface PendingApproval {
	toolName: string;
	settle: (verdict: ToolApprovalVerdict) => void;
}

export class ToolApprovalRegistry {
	private readonly pending = new Map<string, PendingApproval>();

	constructor(private readonly notifier: ToolApprovalNotifier) {}

	/** True while at least one tool call is waiting for an answer. */
	get hasPending(): boolean {
		return this.pending.size > 0;
	}

	/**
	 * Ask the host's user about one tool call and wait for the answer.
	 *
	 * Resolves rather than rejects on every outcome: the caller turns the verdict
	 * into a tool result the model reads, and an exception here would surface as an
	 * opaque loop error instead.
	 */
	async request(request: ToolApprovalRequest, signal?: AbortSignal): Promise<ToolApprovalVerdict> {
		if (signal?.aborted) return "aborted";

		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;

		const verdict = await new Promise<ToolApprovalVerdict>((resolve) => {
			let settled = false;
			const settle = (value: ToolApprovalVerdict) => {
				if (settled) return;
				settled = true;
				resolve(value);
			};

			this.pending.set(request.toolCallId, { toolName: request.toolName, settle });

			// Deliberately not unref'd. The timeout is the guarantee that a wait
			// always ends, so it has to keep the loop alive to fire — an unref'd
			// timer lets a host with nothing else pending exit mid-wait instead,
			// and the run then dies without ever resolving the request.
			timer = setTimeout(() => settle("timeout"), resolveApprovalTimeoutMs());

			onAbort = () => settle("aborted");
			signal?.addEventListener("abort", onAbort, { once: true });

			this.notifier.request(request);
		});

		if (timer) clearTimeout(timer);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
		this.pending.delete(request.toolCallId);
		this.notifier.resolved(request.toolCallId, request.toolName, verdict);
		return verdict;
	}

	/**
	 * Answer one waiting tool call. Returns false when nothing is waiting under
	 * that id — the host turns that into a 409 rather than a silent success, so a
	 * double-click cannot look like two separate approvals.
	 */
	resolve(toolCallId: string, decision: ToolApprovalDecision): boolean {
		const entry = this.pending.get(toolCallId);
		if (!entry) return false;
		entry.settle(decision);
		return true;
	}

	/** Abandon every wait — the run was stopped, or the client went away. */
	cancelAll(verdict: Extract<ToolApprovalVerdict, "aborted" | "denied" | "timeout"> = "aborted"): void {
		for (const entry of [...this.pending.values()]) entry.settle(verdict);
	}
}

/**
 * Message the model receives in place of the tool result when a call is not
 * approved.
 *
 * The "aborted" text is a fallback the model rarely sees: the agent loop
 * re-checks the abort signal the instant this hook returns and substitutes its
 * own "Operation aborted" result before it looks at the block reason. It stays
 * here so the verdict is never reported as an empty block.
 */
export function approvalBlockReason(toolName: string, verdict: ToolApprovalVerdict): string {
	switch (verdict) {
		case "denied":
			return `The user denied the ${toolName} tool for this call. Do not retry it; explain what you needed it for and offer an alternative.`;
		case "timeout":
			return `The ${toolName} tool is not auto-approved for this workspace and no answer arrived in time. Continue without it and tell the user it is still waiting to be allowed.`;
		default:
			return `The run was stopped while ${toolName} was waiting for approval.`;
	}
}
