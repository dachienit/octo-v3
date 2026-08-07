import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { listBackgroundShells, readBackgroundShell } from "../background-shells.js";
import { truncateTail } from "./truncate.js";

const bashOutputSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're checking (shown to user)" }),
	bash_id: Type.String({ description: "Shell id returned by bash when run_in_background was set" }),
	filter: Type.Optional(
		Type.String({ description: "Regular expression; only matching output lines are returned" }),
	),
});

interface BashOutputToolDetails {
	shellId: string;
	status: string;
	exitCode?: number;
	lostOutput: boolean;
}

export function createBashOutputTool(): AgentTool<typeof bashOutputSchema> {
	return {
		name: "bash_output",
		label: "bash_output",
		description:
			"Read output from a background shell started by bash with run_in_background. Each call returns only the output produced since the previous call, along with the shell's current status. Optionally filter lines with a regular expression.",
		parameters: bashOutputSchema,
		execute: async (_toolCallId: string, { bash_id, filter }: { label: string; bash_id: string; filter?: string }) => {
			let read: ReturnType<typeof readBackgroundShell>;
			try {
				read = readBackgroundShell(bash_id, filter);
			} catch (cause) {
				const known = listBackgroundShells()
					.map((shell) => `${shell.id} (${shell.status})`)
					.join(", ");
				const message = cause instanceof Error ? cause.message : String(cause);
				throw new Error(known ? `${message}. Known shells: ${known}` : message);
			}

			const sections: string[] = [];
			if (read.stdout) sections.push(`<stdout>\n${read.stdout}\n</stdout>`);
			if (read.stderr) sections.push(`<stderr>\n${read.stderr}\n</stderr>`);
			if (sections.length === 0) sections.push("(no new output)");

			const statusLine =
				read.exitCode === undefined
					? `Status: ${read.status}`
					: `Status: ${read.status} (exit code ${read.exitCode})`;

			let text = `${statusLine}\n\n${truncateTail(sections.join("\n\n")).content}`;
			if (read.truncated) {
				text += "\n\n[Some earlier output was dropped because the retention buffer filled up. Poll more frequently.]";
			}

			return {
				content: [{ type: "text", text }],
				details: {
					shellId: read.id,
					status: read.status,
					exitCode: read.exitCode,
					lostOutput: read.truncated,
				} satisfies BashOutputToolDetails,
			};
		},
	};
}
