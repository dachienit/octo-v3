import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { killBackgroundShell, listBackgroundShells } from "../background-shells.js";

const killShellSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're stopping (shown to user)" }),
	shell_id: Type.String({ description: "Shell id returned by bash when run_in_background was set" }),
});

interface KillShellToolDetails {
	shellId: string;
	status: string;
}

export function createKillShellTool(): AgentTool<typeof killShellSchema> {
	return {
		name: "kill_shell",
		label: "kill_shell",
		description:
			"Terminate a background shell started by bash with run_in_background, including any child processes it started. Already-finished shells are reported as-is.",
		parameters: killShellSchema,
		execute: async (_toolCallId: string, { shell_id }: { label: string; shell_id: string }) => {
			let shell: Awaited<ReturnType<typeof killBackgroundShell>>;
			try {
				shell = await killBackgroundShell(shell_id);
			} catch (cause) {
				const known = listBackgroundShells()
					.map((entry) => `${entry.id} (${entry.status})`)
					.join(", ");
				const message = cause instanceof Error ? cause.message : String(cause);
				throw new Error(known ? `${message}. Known shells: ${known}` : message);
			}

			return {
				content: [{ type: "text", text: `Shell ${shell.id} is now ${shell.status}: ${shell.command}` }],
				details: { shellId: shell.id, status: shell.status } satisfies KillShellToolDetails,
			};
		},
	};
}
