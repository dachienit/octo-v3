import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { formatTodos, type SessionStateStore, type TodoItem } from "../session-state.js";

const todoItemSchema = Type.Object({
	content: Type.String({ description: 'Imperative description of the task, e.g. "Add the grep tool"' }),
	status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")], {
		description: "Current state of this task",
	}),
	activeForm: Type.String({ description: 'Present-tense label shown while in progress, e.g. "Adding the grep tool"' }),
});

const todoWriteSchema = Type.Object({
	label: Type.String({ description: "Brief description of the plan update (shown to user)" }),
	todos: Type.Array(todoItemSchema, { description: "The complete task list; it replaces the previous one" }),
});

interface TodoWriteToolDetails {
	todos: TodoItem[];
	pending: number;
	inProgress: number;
	completed: number;
}

export function createTodoWriteTool(store: SessionStateStore): AgentTool<typeof todoWriteSchema> {
	return {
		name: "todo_write",
		label: "todo_write",
		description:
			"Create and update the task list for the current session, so multi-step work stays visible to the user. Always send the complete list; it replaces the previous one. Keep exactly one task in_progress at a time and mark it completed as soon as it is done.",
		parameters: todoWriteSchema,
		// Sequential: the list is shared state, and concurrent writes would race.
		executionMode: "sequential",
		execute: async (_toolCallId: string, { todos }: { label: string; todos: TodoItem[] }) => {
			const inProgress = todos.filter((todo) => todo.status === "in_progress");
			if (inProgress.length > 1) {
				throw new Error(
					`Only one task may be in_progress at a time, got ${inProgress.length}: ${inProgress.map((todo) => todo.content).join(", ")}`,
				);
			}

			store.setTodos(todos);

			const completed = todos.filter((todo) => todo.status === "completed").length;
			const text = `${formatTodos(todos)}\n\n[${completed}/${todos.length} completed]`;

			return {
				content: [{ type: "text", text }],
				details: {
					todos,
					pending: todos.filter((todo) => todo.status === "pending").length,
					inProgress: inProgress.length,
					completed,
				} satisfies TodoWriteToolDetails,
			};
		},
	};
}
