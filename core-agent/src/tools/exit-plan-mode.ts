import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { SessionStateStore } from "../session-state.js";

const exitPlanModeSchema = Type.Object({
	label: Type.String({ description: "Brief description of the plan (shown to user)" }),
	plan: Type.String({ description: "The plan you intend to execute, in Markdown, concise but specific" }),
});

interface ExitPlanModeToolDetails {
	plan: string;
	previousMode: string;
}

export function createExitPlanModeTool(store: SessionStateStore): AgentTool<typeof exitPlanModeSchema> {
	return {
		name: "exit_plan_mode",
		label: "exit_plan_mode",
		description:
			"Present the plan you have prepared and leave plan mode so implementation can start. Only call this after research is complete and you know what you intend to change. Do not use it to report work that is already finished.",
		parameters: exitPlanModeSchema,
		executionMode: "sequential",
		execute: async (_toolCallId: string, { plan }: { label: string; plan: string }) => {
			const previousMode = store.getMode();
			if (previousMode !== "plan") {
				return {
					content: [
						{
							type: "text",
							text: "Plan mode was not active, so nothing changed. You can proceed with the work directly.",
						},
					],
					details: { plan, previousMode } satisfies ExitPlanModeToolDetails,
				};
			}

			store.setMode("default");
			return {
				content: [{ type: "text", text: `Plan mode exited. Editing tools are available again.\n\n${plan}` }],
				details: { plan, previousMode } satisfies ExitPlanModeToolDetails,
			};
		},
	};
}
