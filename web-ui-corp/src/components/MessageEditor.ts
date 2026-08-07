import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Select, type SelectOption } from "@mariozechner/mini-lit/dist/Select.js";
import type { Model } from "@octo/core-agent/web";
import { html, LitElement, render as litRender } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { createRef, ref } from "lit/directives/ref.js";
import {
	ArrowUp,
	Brain,
	Check,
	ChevronDown,
	ChevronRight,
	FolderUp,
	Image,
	Loader2,
	Paperclip,
	Plus,
	Send,
	Sparkles,
	Square,
	Upload,
} from "lucide";
import { type Attachment, loadAttachment, matchesAccept } from "../utils/attachment-utils.js";
import { i18n } from "../utils/i18n.js";
import {
	filterCandidates,
	findActiveMention,
	type MentionCandidate,
	resolveMentions,
} from "../utils/mention-utils.js";
import type { MentionPayload } from "../adapters/core-service.js";
import {
	type ComposerSkill,
	filterSkills,
	findActiveSkillCommand,
	resolveSkillCommands,
} from "../utils/skill-utils.js";
import "./AttachmentTile.js";
import "./MentionPopover.js";
import "./SkillPopover.js";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

type ReasoningValue = "off" | "minimal" | "low" | "medium" | "high";
const REASONING_LEVELS: { value: ReasoningValue; label: string }[] = [
	{ value: "off", label: "Off" },
	{ value: "minimal", label: "Minimal" },
	{ value: "low", label: "Low" },
	{ value: "medium", label: "Medium" },
	{ value: "high", label: "High" },
];

export type QuickModelOption = { value: string; label: string; provider: string };

export type { ComposerSkill };

/** Rows shown in the `@` picker at once; a materialized SAP tree is far larger. */
const MAX_MENTION_MATCHES = 50;

/** A workspace rarely has this many skills, but the panel should never grow unbounded. */
const MAX_SKILL_MATCHES = 20;

/** Chips rendered before the rest collapse behind a "+N more" toggle. */
const VISIBLE_ATTACHMENTS = 12;

/** A picked folder always drags in build output and VCS metadata; never attach those. */
const FOLDER_SKIP_DIRS = new Set([".git", "node_modules", "dist", ".octo"]);
const FOLDER_SKIP_NAMES = new Set([".DS_Store", "Thumbs.db"]);

/**
 * A scanned folder awaiting confirmation. Nothing is read until the user accepts,
 * so a mis-picked folder costs one directory walk rather than a base64 encode of
 * everything inside it.
 */
type FolderPick = {
	folderName: string;
	entries: Array<{ file: File; path: string }>;
	bytes: number;
	skipped: string[];
	/** Set when the pick cannot be attached; the dialog still opens to say why. */
	error: string;
};

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

@customElement("message-editor")
export class MessageEditor extends LitElement {
	private _value = "";
	private textareaRef = createRef<HTMLTextAreaElement>();

	@property()
	get value() {
		return this._value;
	}

	set value(val: string) {
		const oldValue = this._value;
		this._value = val;
		this.requestUpdate("value", oldValue);
	}

	@property() declare isStreaming: boolean;
	@property() declare currentModel: Model<any> | undefined;
	@property() declare thinkingLevel: ThinkingLevel;
	@property() declare showAttachmentButton: boolean;
	@property() declare showModelSelector: boolean;
	@property() declare showThinkingSelector: boolean;
	@property() declare onInput: ((value: string) => void) | undefined;
	@property() declare onSend:
		| ((input: string, attachments: Attachment[], mentions: MentionPayload[], skills: string[]) => void)
		| undefined;
	/** Files and folders taggable with `@`. Empty disables the picker entirely. */
	@property({ attribute: false }) declare mentionCandidates: MentionCandidate[];
	@property() declare onAbort: (() => void) | undefined;
	@property() declare onModelSelect: (() => void) | undefined;
	@property() declare onThinkingChange: ((level: "off" | "minimal" | "low" | "medium" | "high") => void) | undefined;
	@property() declare onFilesChange: ((files: Attachment[]) => void) | undefined;
	@property() declare attachments: Attachment[];
	@property() declare maxFiles: number;
	@property() declare maxFileSize: number;
	@property() declare acceptedTypes: string;
	/** Ceiling for one "Add folder" pick, counted together with what is already attached. */
	@property() declare maxFolderFiles: number;
	@property() declare maxFolderBytes: number;
	/** Skills offered by the `+` menu. Empty hides the section unless upload is wired. */
	@property({ attribute: false }) declare skills: ComposerSkill[];
	/** Called when the Skills submenu opens, so the host can load descriptions lazily. */
	@property() declare onSkillsMenuOpen: (() => void) | undefined;
	/** Called by "Browser Skills"; the host owns the upload flow. */
	@property() declare onSkillUpload: (() => void) | undefined;
	@property() declare useQuickSelector: boolean;
	@property() declare quickModels: QuickModelOption[];
	@property() declare selectedModelValue: string;
	@property() declare onModelChange: ((value: string) => void) | undefined;

	@state() declare processingFiles: boolean;
	@state() declare isDragging: boolean;
	@state() declare quickMenuOpen: boolean;
	@state() declare quickSubmenuOpen: boolean;
	@state() declare quickMenuAnchor: DOMRect | null;
	@state() declare mentionOpen: boolean;
	@state() declare mentionQuery: string;
	@state() declare mentionIndex: number;
	@state() declare mentionAnchor: DOMRect | null;
	@state() declare skillPickerOpen: boolean;
	@state() declare skillQuery: string;
	@state() declare skillIndex: number;
	@state() declare skillAnchor: DOMRect | null;
	@state() declare attachMenuOpen: boolean;
	@state() declare attachSkillsOpen: boolean;
	@state() declare attachMenuAnchor: DOMRect | null;
	/** Rect of the Skills row, so its flyout can sit beside it. */
	@state() declare skillsRowAnchor: DOMRect | null;
	@state() declare folderPick: FolderPick | null;
	@state() declare attachmentsExpanded: boolean;

	private fileInputRef = createRef<HTMLInputElement>();
	private folderInputRef = createRef<HTMLInputElement>();
	private quickAnchorRef = createRef<HTMLDivElement>();
	private attachAnchorRef = createRef<HTMLDivElement>();
	private composerRef = createRef<HTMLDivElement>();
	private menuPortal?: HTMLDivElement;
	private attachMenuPortal?: HTMLDivElement;
	private folderDialogPortal?: HTMLDivElement;
	private mentionPortal?: HTMLDivElement;
	private skillPortal?: HTMLDivElement;
	/** Offset of the `@` that opened the picker, so insertion can replace the token. */
	private mentionStart = 0;
	/** Same, for the `/` that opened the skill picker. */
	private skillStart = 0;

	constructor() {
		super();
		this.isStreaming = false;
		this.currentModel = undefined;
		this.thinkingLevel = "off";
		this.showAttachmentButton = true;
		this.showModelSelector = true;
		this.showThinkingSelector = true;
		this.onInput = undefined;
		this.onSend = undefined;
		this.onAbort = undefined;
		this.onModelSelect = undefined;
		this.onThinkingChange = undefined;
		this.onFilesChange = undefined;
		this.attachments = [];
		this.maxFiles = 10;
		this.maxFileSize = 20 * 1024 * 1024; // 20MB
		this.acceptedTypes =
			"image/*,application/pdf,.docx,.pptx,.xlsx,.xls,.txt,.md,.json,.xml,.html,.css,.js,.ts,.jsx,.tsx,.yml,.yaml";
		this.maxFolderFiles = 50;
		this.maxFolderBytes = 25 * 1024 * 1024; // 25MB, well under the service's JSON body cap
		this.skills = [];
		this.onSkillsMenuOpen = undefined;
		this.onSkillUpload = undefined;
		this.attachMenuOpen = false;
		this.attachSkillsOpen = false;
		this.attachMenuAnchor = null;
		this.skillsRowAnchor = null;
		this.folderPick = null;
		this.attachmentsExpanded = false;
		this.processingFiles = false;
		this.isDragging = false;
		this.useQuickSelector = false;
		this.quickModels = [];
		this.selectedModelValue = "";
		this.onModelChange = undefined;
		this.quickMenuOpen = false;
		this.quickSubmenuOpen = false;
		this.quickMenuAnchor = null;
		this.mentionCandidates = [];
		this.mentionOpen = false;
		this.mentionQuery = "";
		this.mentionIndex = 0;
		this.mentionAnchor = null;
		this.skillPickerOpen = false;
		this.skillQuery = "";
		this.skillIndex = 0;
		this.skillAnchor = null;
	}

	/** Matches for the token currently being typed, capped so a huge tree stays usable. */
	private get mentionMatches(): MentionCandidate[] {
		return filterCandidates(this.mentionCandidates, this.mentionQuery, MAX_MENTION_MATCHES);
	}

	private get skillMatches(): ComposerSkill[] {
		return filterSkills(this.skills, this.skillQuery, MAX_SKILL_MATCHES);
	}

	/**
	 * Keeps both token pickers in step with the caret. `@` is resolved first and wins:
	 * only one picker may be open, and both claim the same keys.
	 */
	private syncPickers() {
		this.syncMentionState();
		if (this.mentionOpen) {
			this.closeSkillPicker();
			return;
		}
		this.syncSkillState();
	}

	/**
	 * Opens, updates or closes the picker based on where the caret sits. Called after
	 * every input and caret move, so the picker tracks the token rather than latching
	 * open once triggered.
	 */
	private syncMentionState() {
		const textarea = this.textareaRef.value;
		if (!textarea || this.mentionCandidates.length === 0) {
			this.mentionOpen = false;
			return;
		}

		const active = findActiveMention(this.value, textarea.selectionStart ?? 0);
		if (!active) {
			this.mentionOpen = false;
			return;
		}

		this.mentionStart = active.start;
		if (active.query !== this.mentionQuery) this.mentionIndex = 0;
		this.mentionQuery = active.query;
		this.mentionAnchor = this.composerRef.value?.getBoundingClientRect() ?? null;
		this.mentionOpen = true;
	}

	private closeMention() {
		this.mentionOpen = false;
		this.mentionQuery = "";
		this.mentionIndex = 0;
	}

	/**
	 * Replaces the in-progress `@token` with the chosen one and moves the caret past it.
	 *
	 * A directory completes to `@dir/` with no trailing space and leaves the picker open on
	 * its contents, so Tab walks down a tree one level at a time. A file terminates the
	 * token with a space. The new query is re-derived from the text rather than assigned,
	 * so stepping in is indistinguishable from the user typing `dir/` by hand.
	 */
	private applyMention(candidate: MentionCandidate) {
		const textarea = this.textareaRef.value;
		const caret = textarea?.selectionStart ?? this.value.length;
		const drillDown = candidate.type === "directory";
		const inserted = drillDown ? `@${candidate.token}` : `@${candidate.token} `;
		this.value = this.value.slice(0, this.mentionStart) + inserted + this.value.slice(caret);
		if (!drillDown) this.closeMention();
		this.onInput?.(this.value);

		const nextCaret = this.mentionStart + inserted.length;
		void this.updateComplete.then(() => {
			const el = this.textareaRef.value;
			if (!el) return;
			el.focus();
			el.setSelectionRange(nextCaret, nextCaret);
			if (drillDown) this.syncPickers();
		});
	}

	/** The `/` half of `syncPickers`, mirroring `syncMentionState`. */
	private syncSkillState() {
		const textarea = this.textareaRef.value;
		if (!textarea || this.skills.length === 0) {
			this.skillPickerOpen = false;
			return;
		}

		const active = findActiveSkillCommand(this.value, textarea.selectionStart ?? 0);
		if (!active) {
			this.skillPickerOpen = false;
			return;
		}

		this.skillStart = active.start;
		if (active.query !== this.skillQuery) this.skillIndex = 0;
		this.skillQuery = active.query;
		this.skillAnchor = this.composerRef.value?.getBoundingClientRect() ?? null;
		this.skillPickerOpen = true;
	}

	private closeSkillPicker() {
		this.skillPickerOpen = false;
		this.skillQuery = "";
		this.skillIndex = 0;
	}

	/** Replaces the in-progress `/token` with the chosen skill and moves the caret past it. */
	private applySkillCommand(skill: ComposerSkill) {
		const textarea = this.textareaRef.value;
		const caret = textarea?.selectionStart ?? this.value.length;
		const inserted = `/${skill.name} `;
		this.value = this.value.slice(0, this.skillStart) + inserted + this.value.slice(caret);
		this.closeSkillPicker();
		this.onInput?.(this.value);

		const nextCaret = this.skillStart + inserted.length;
		void this.updateComplete.then(() => {
			const el = this.textareaRef.value;
			if (!el) return;
			el.focus();
			el.setSelectionRange(nextCaret, nextCaret);
		});
	}

	/** Inserts a mention from outside the composer (the file tree's "mention" action). */
	insertMention(candidate: MentionCandidate) {
		this.closeMention();
		this.insertTextAtCaret(`@${candidate.token} `);
	}

	/**
	 * Drops text in at the caret, separating it from whatever precedes it, and leaves the
	 * caret after it so typing continues naturally. Shared by mentions and the skill picker.
	 */
	private insertTextAtCaret(text: string) {
		const textarea = this.textareaRef.value;
		const caret = textarea?.selectionStart ?? this.value.length;
		const needsSpace = caret > 0 && !/\s/.test(this.value[caret - 1] ?? " ");
		const inserted = `${needsSpace ? " " : ""}${text}`;
		this.value = this.value.slice(0, caret) + inserted + this.value.slice(caret);
		this.onInput?.(this.value);

		const nextCaret = caret + inserted.length;
		void this.updateComplete.then(() => {
			const el = this.textareaRef.value;
			if (!el) return;
			el.focus();
			el.setSelectionRange(nextCaret, nextCaret);
		});
	}

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	private handleTextareaInput = (e: Event) => {
		const textarea = e.target as HTMLTextAreaElement;
		this.value = textarea.value;
		this.syncPickers();
		this.onInput?.(this.value);
	};

	/** Clicking or arrowing out of the token has to close the picker too. */
	private handleSelectionChange = () => {
		if (this.mentionOpen || this.skillPickerOpen) this.syncPickers();
	};

	/**
	 * Gives the open token picker first claim on the navigation keys. Enter would
	 * otherwise send the message and Escape would abort a running stream, and while a
	 * picker is open both belong to it. Returns true when the key was consumed.
	 */
	private handlePickerKey<T>(
		e: KeyboardEvent,
		picker: {
			matches: T[];
			index: number;
			setIndex: (index: number) => void;
			pick: (item: T) => void;
			close: () => void;
		},
	): boolean {
		const { matches } = picker;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			picker.setIndex(matches.length === 0 ? 0 : (picker.index + 1) % matches.length);
			return true;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			picker.setIndex(matches.length === 0 ? 0 : (picker.index - 1 + matches.length) % matches.length);
			return true;
		}
		if (e.key === "Enter" || e.key === "Tab") {
			const picked = matches[picker.index];
			if (picked) {
				e.preventDefault();
				e.stopPropagation();
				picker.pick(picked);
				return true;
			}
			// Nothing to pick: close and fall through so Enter still sends.
			picker.close();
			return false;
		}
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			picker.close();
			return true;
		}
		return false;
	}

	private handleKeyDown = (e: KeyboardEvent) => {
		if (this.mentionOpen) {
			const consumed = this.handlePickerKey(e, {
				matches: this.mentionMatches,
				index: this.mentionIndex,
				setIndex: (index) => {
					this.mentionIndex = index;
				},
				pick: (candidate) => this.applyMention(candidate),
				close: () => this.closeMention(),
			});
			if (consumed) return;
		} else if (this.skillPickerOpen) {
			const consumed = this.handlePickerKey(e, {
				matches: this.skillMatches,
				index: this.skillIndex,
				setIndex: (index) => {
					this.skillIndex = index;
				},
				pick: (skill) => this.applySkillCommand(skill),
				close: () => this.closeSkillPicker(),
			});
			if (consumed) return;
		}

		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			if (
				!this.isStreaming &&
				!this.processingFiles &&
				(this.value.trim() || this.attachments.length > 0) &&
				(!this.useQuickSelector || this.selectedModelValue)
			) {
				this.handleSend();
			}
		} else if (e.key === "Escape" && this.isStreaming) {
			e.preventDefault();
			this.onAbort?.();
		}
	};

	private handlePaste = async (e: ClipboardEvent) => {
		const items = e.clipboardData?.items;
		if (!items) return;

		const imageFiles: File[] = [];

		// Check for image items in clipboard
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (item.type.startsWith("image/")) {
				const file = item.getAsFile();
				if (file) {
					imageFiles.push(file);
				}
			}
		}

		// If we found images, process them
		if (imageFiles.length > 0) {
			e.preventDefault(); // Prevent default paste behavior

			const rejection = this.batchRejection(imageFiles.length);
			if (rejection) {
				alert(rejection);
				return;
			}

			this.processingFiles = true;
			const newAttachments: Attachment[] = [];

			for (const file of imageFiles) {
				try {
					if (file.size > this.maxFileSize) {
						alert(`Image exceeds maximum size of ${Math.round(this.maxFileSize / 1024 / 1024)}MB`);
						continue;
					}

					const attachment = await loadAttachment(file);
					newAttachments.push(attachment);
				} catch (error) {
					console.error("Error processing pasted image:", error);
					alert(`Failed to process pasted image: ${String(error)}`);
				}
			}

			this.attachments = [...this.attachments, ...newAttachments];
			this.onFilesChange?.(this.attachments);
			this.processingFiles = false;
		}
	};

	/**
	 * A single pick, paste or drop stays capped at maxFiles, but the composer as a whole is
	 * capped at maxFolderFiles — one "Add folder" can legitimately put dozens of files in,
	 * and a follow-up file should not then be refused for a limit the folder already passed.
	 */
	private batchRejection(count: number): string | null {
		if (count > this.maxFiles) return `Maximum ${this.maxFiles} files at once`;
		if (count + this.attachments.length > this.maxFolderFiles) return `Maximum ${this.maxFolderFiles} attachments`;
		return null;
	}

	private handleSend = () => {
		// Mentions and `/skill` invocations are both derived from the final text rather
		// than tracked while typing, so editing or deleting a token is reflected for free.
		this.closeMention();
		this.closeSkillPicker();
		this.onSend?.(
			this.value,
			this.attachments,
			resolveMentions(this.value, this.mentionCandidates),
			resolveSkillCommands(this.value, this.skills),
		);
	};

	private toggleAttachMenu() {
		if (this.attachMenuOpen) {
			this.closeAttachMenu();
			return;
		}
		this.attachMenuAnchor = this.attachAnchorRef.value?.getBoundingClientRect() ?? null;
		this.attachMenuOpen = true;
		this.attachSkillsOpen = false;
	}

	private closeAttachMenu() {
		this.attachMenuOpen = false;
		this.attachSkillsOpen = false;
	}

	private handleAttachmentClick = () => {
		this.closeAttachMenu();
		this.fileInputRef.value?.click();
	};

	private handleFolderClick = () => {
		this.closeAttachMenu();
		this.folderInputRef.value?.click();
	};

	private async handleFilesSelected(e: Event) {
		const input = e.target as HTMLInputElement;
		const files = Array.from(input.files || []);
		if (files.length === 0) return;

		const rejection = this.batchRejection(files.length);
		if (rejection) {
			alert(rejection);
			input.value = "";
			return;
		}

		this.processingFiles = true;
		const newAttachments: Attachment[] = [];

		for (const file of files) {
			try {
				if (file.size > this.maxFileSize) {
					alert(`${file.name} exceeds maximum size of ${Math.round(this.maxFileSize / 1024 / 1024)}MB`);
					continue;
				}

				const attachment = await loadAttachment(file);
				newAttachments.push(attachment);
			} catch (error) {
				console.error(`Error processing ${file.name}:`, error);
				alert(`Failed to process ${file.name}: ${String(error)}`);
			}
		}

		this.attachments = [...this.attachments, ...newAttachments];
		this.onFilesChange?.(this.attachments);
		this.processingFiles = false;
		input.value = ""; // Reset input
	}

	/**
	 * A folder picker hands over every file it found, each carrying its path relative to
	 * the picked folder in webkitRelativePath. Only scan and filter here — reading bytes
	 * waits for the confirmation dialog.
	 */
	private handleFolderSelected = (e: Event) => {
		const input = e.target as HTMLInputElement;
		const picked = Array.from(input.files ?? []);
		input.value = ""; // Reset so picking the same folder again still fires a change event.
		if (picked.length === 0) return;

		const relPathOf = (file: File) => (file.webkitRelativePath || file.name).replace(/\\/g, "/");
		const folderName = relPathOf(picked[0]).split("/")[0] || picked[0].name;

		const entries: Array<{ file: File; path: string }> = [];
		const skipped: string[] = [];
		let bytes = 0;
		for (const file of picked) {
			// The picked folder stays in the path: the service rebuilds the tree under the
			// session's attachments, so the upload lands as the folder the user chose.
			const segments = relPathOf(file).split("/");
			const rel = segments.join("/");
			const name = segments[segments.length - 1] ?? file.name;
			if (
				FOLDER_SKIP_NAMES.has(name) ||
				// The picked folder itself is never a "skip dir" — only what it contains.
				segments.slice(1, -1).some((seg) => FOLDER_SKIP_DIRS.has(seg)) ||
				!matchesAccept(file, this.acceptedTypes) ||
				file.size > this.maxFileSize
			) {
				skipped.push(rel);
				continue;
			}
			entries.push({ file, path: rel });
			bytes += file.size;
		}

		// The dialog opens either way: a folder that yields nothing needs to say so
		// rather than look like a picker that did not fire.
		let error = "";
		if (entries.length === 0) {
			error = i18n("That folder has no attachable files");
		} else if (entries.length + this.attachments.length > this.maxFolderFiles) {
			error = `That folder has ${entries.length} attachable files; the limit is ${this.maxFolderFiles}`;
		} else if (bytes > this.maxFolderBytes) {
			error = `That folder is ${formatBytes(bytes)}; the limit is ${formatBytes(this.maxFolderBytes)}`;
		}

		this.folderPick = { folderName, entries, bytes, skipped, error };
	};

	/**
	 * Reads the confirmed folder. Each file keeps its relative path as its name, which the
	 * service flattens into the stored filename — so the agent still sees where it came from.
	 */
	private async confirmFolderPick() {
		const pick = this.folderPick;
		if (!pick || pick.error || this.processingFiles) return;

		this.processingFiles = true;
		this.folderPick = null;
		const loaded: Attachment[] = [];
		const failed: string[] = [];
		for (const entry of pick.entries) {
			try {
				loaded.push(await loadAttachment(entry.file, entry.path));
			} catch (error) {
				console.error(`Error processing ${entry.path}:`, error);
				failed.push(entry.path);
			}
		}

		this.attachments = [...this.attachments, ...loaded];
		this.onFilesChange?.(this.attachments);
		this.processingFiles = false;
		// One summary instead of an alert per file — a folder can fail in bulk.
		if (failed.length > 0) {
			const shown = failed.slice(0, 5).join("\n");
			alert(`Could not read ${failed.length} file(s):\n${shown}${failed.length > 5 ? "\n…" : ""}`);
		}
	}

	private removeFile(fileId: string) {
		this.attachments = this.attachments.filter((f) => f.id !== fileId);
		if (this.attachments.length === 0) this.attachmentsExpanded = false;
		this.onFilesChange?.(this.attachments);
	}

	private handleDragOver = (e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		if (!this.isDragging) {
			this.isDragging = true;
		}
	};

	private handleDragLeave = (e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		// Only set isDragging to false if we're leaving the entire component
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const x = e.clientX;
		const y = e.clientY;
		if (x <= rect.left || x >= rect.right || y <= rect.top || y >= rect.bottom) {
			this.isDragging = false;
		}
	};

	private handleDrop = async (e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		this.isDragging = false;

		const files = Array.from(e.dataTransfer?.files || []);
		if (files.length === 0) return;

		const rejection = this.batchRejection(files.length);
		if (rejection) {
			alert(rejection);
			return;
		}

		this.processingFiles = true;
		const newAttachments: Attachment[] = [];

		for (const file of files) {
			try {
				if (file.size > this.maxFileSize) {
					alert(`${file.name} exceeds maximum size of ${Math.round(this.maxFileSize / 1024 / 1024)}MB`);
					continue;
				}

				const attachment = await loadAttachment(file);
				newAttachments.push(attachment);
			} catch (error) {
				console.error(`Error processing ${file.name}:`, error);
				alert(`Failed to process ${file.name}: ${String(error)}`);
			}
		}

		this.attachments = [...this.attachments, ...newAttachments];
		this.onFilesChange?.(this.attachments);
		this.processingFiles = false;
	};

	override firstUpdated() {
		const textarea = this.textareaRef.value;
		if (textarea) {
			textarea.focus();
		}
	}

	override willUpdate(changed: Map<string, unknown>) {
		// The host clears attachments after a send; collapse again so the next batch
		// does not start expanded.
		if (changed.has("attachments") && this.attachments.length === 0) this.attachmentsExpanded = false;
	}

	override updated() {
		this.syncQuickMenuPortal();
		this.syncAttachMenuPortal();
		this.syncFolderDialogPortal();
		this.syncMentionPortal();
		this.syncSkillPortal();
	}

	override connectedCallback() {
		super.connectedCallback();
		document.addEventListener("selectionchange", this.handleSelectionChange);
	}

	/** Same portal trick as the quick menu: the composer card clips overflow. */
	private syncMentionPortal() {
		if (this.mentionOpen) {
			if (!this.mentionPortal) {
				this.mentionPortal = document.createElement("div");
				document.body.appendChild(this.mentionPortal);
			}
			litRender(this.renderMentionContent(), this.mentionPortal);
		} else if (this.mentionPortal) {
			litRender(html``, this.mentionPortal);
			this.mentionPortal.remove();
			this.mentionPortal = undefined;
		}
	}

	/** The `/` picker rides the same portal trick as `@`. */
	private syncSkillPortal() {
		if (this.skillPickerOpen) {
			if (!this.skillPortal) {
				this.skillPortal = document.createElement("div");
				document.body.appendChild(this.skillPortal);
			}
			litRender(this.renderSkillPickerContent(), this.skillPortal);
		} else if (this.skillPortal) {
			litRender(html``, this.skillPortal);
			this.skillPortal.remove();
			this.skillPortal = undefined;
		}
	}

	private renderSkillPickerContent() {
		return html`
			<skill-popover
				.items=${this.skillMatches}
				.selectedIndex=${this.skillIndex}
				.anchor=${this.skillAnchor}
				.onPick=${(skill: ComposerSkill) => this.applySkillCommand(skill)}
				.onDismiss=${() => this.closeSkillPicker()}
				.onHoverIndex=${(index: number) => {
					this.skillIndex = index;
				}}
			></skill-popover>
		`;
	}

	private renderMentionContent() {
		return html`
			<mention-popover
				.items=${this.mentionMatches}
				.selectedIndex=${this.mentionIndex}
				.anchor=${this.mentionAnchor}
				.onPick=${(candidate: MentionCandidate) => this.applyMention(candidate)}
				.onDismiss=${() => this.closeMention()}
				.onHoverIndex=${(index: number) => {
					this.mentionIndex = index;
				}}
			></mention-popover>
		`;
	}

	private toggleQuickMenu() {
		if (this.quickMenuOpen) {
			this.quickMenuOpen = false;
			this.quickSubmenuOpen = false;
			return;
		}
		this.quickMenuAnchor = this.quickAnchorRef.value?.getBoundingClientRect() ?? null;
		this.quickMenuOpen = true;
		this.quickSubmenuOpen = false;
	}

	private renderQuickSelector() {
		const selected = this.quickModels.find((m) => m.value === this.selectedModelValue);
		const modelLabel = selected?.label ?? i18n("None");
		const levelLabel = REASONING_LEVELS.find((l) => l.value === String(this.thinkingLevel))?.label ?? "Off";
		return html`
			<div class="relative" ${ref(this.quickAnchorRef)}>
				${Button({
					variant: "ghost",
					size: "sm",
					className: "h-8 gap-1 text-xs",
					onClick: () => this.toggleQuickMenu(),
					children: html`
						<span class="max-w-[10rem] truncate font-medium">${modelLabel}</span>
						<span class="text-muted-foreground">${levelLabel}</span>
						${icon(ChevronDown, "sm")}
					`,
				})}
			</div>
		`;
	}

	/** Same portal trick as the quick menu — the composer card clips overflow. */
	private syncAttachMenuPortal() {
		if (this.attachMenuOpen) {
			if (!this.attachMenuPortal) {
				this.attachMenuPortal = document.createElement("div");
				document.body.appendChild(this.attachMenuPortal);
			}
			litRender(this.renderAttachMenuContent(), this.attachMenuPortal);
		} else if (this.attachMenuPortal) {
			litRender(html``, this.attachMenuPortal);
			this.attachMenuPortal.remove();
			this.attachMenuPortal = undefined;
		}
	}

	private syncFolderDialogPortal() {
		if (this.folderPick) {
			if (!this.folderDialogPortal) {
				this.folderDialogPortal = document.createElement("div");
				document.body.appendChild(this.folderDialogPortal);
			}
			litRender(this.renderFolderDialogContent(), this.folderDialogPortal);
		} else if (this.folderDialogPortal) {
			litRender(html``, this.folderDialogPortal);
			this.folderDialogPortal.remove();
			this.folderDialogPortal = undefined;
		}
	}

	private renderAttachMenuContent() {
		const a = this.attachMenuAnchor;
		// Anchored bottom-left: the `+` sits on the left of the button row, unlike the
		// right-aligned quick menu.
		const left = a ? Math.max(8, Math.round(a.left)) : 8;
		const bottom = a ? Math.round(window.innerHeight - a.top + 8) : 64;
		const maxH = a ? Math.max(180, Math.round(a.top - 16)) : 360;
		const panelStyle = `position: fixed; left: ${left}px; bottom: ${bottom}px; max-height: ${maxH}px; box-shadow: var(--sapContent_Shadow2, 0 6px 20px rgba(0,0,0,0.18)); font-family: var(--sapFontFamily, inherit);`;
		const rowClass = "flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent";
		const showSkills = this.skills.length > 0 || this.onSkillUpload !== undefined;

		return html`
			<div class="fixed inset-0 z-[999]" @click=${() => this.closeAttachMenu()}></div>
			<div
				class="z-[1000] w-64 overflow-y-auto rounded-md border border-border bg-popover py-1 text-sm text-popover-foreground"
				style=${panelStyle}
				@click=${(e: Event) => e.stopPropagation()}
			>
				<button type="button" class=${rowClass} @click=${this.handleAttachmentClick}>
					${icon(Image, "sm")}<span class="flex-1">${i18n("Add files or photos")}</span>
				</button>
				<button type="button" class=${rowClass} @click=${this.handleFolderClick}>
					${icon(FolderUp, "sm")}<span class="flex-1">${i18n("Add folder")}</span>
				</button>
				${showSkills
					? html`
						<div class="my-1 h-px bg-border"></div>
						<button
							type="button"
							class="${rowClass} ${this.attachSkillsOpen ? "bg-accent" : ""}"
							@click=${(e: Event) => {
								// The flyout is positioned off this row, so measure it on the click
								// rather than guessing from the panel's own geometry.
								this.skillsRowAnchor = (e.currentTarget as HTMLElement).getBoundingClientRect();
								this.attachSkillsOpen = !this.attachSkillsOpen;
								if (this.attachSkillsOpen) this.onSkillsMenuOpen?.();
							}}
						>
							${icon(Sparkles, "sm")}<span class="flex-1">${i18n("Skills")}</span>
							${icon(ChevronRight, "sm")}
						</button>
					`
					: ""}
			</div>
			${showSkills && this.attachSkillsOpen ? this.renderSkillsFlyout(rowClass) : ""}
		`;
	}

	/** Sits beside the Skills row, flipping to its left when the viewport is too narrow. */
	private renderSkillsFlyout(rowClass: string) {
		const row = this.skillsRowAnchor;
		const width = 288; // w-72
		const gap = 4;
		const bottom = row ? Math.round(window.innerHeight - row.bottom) : 64;
		const maxH = row ? Math.max(180, Math.round(row.bottom - 16)) : 360;
		const fitsRight = !row || row.right + gap + width <= window.innerWidth - 8;
		const side = row
			? fitsRight
				? `left: ${Math.round(row.right + gap)}px;`
				: `right: ${Math.round(window.innerWidth - row.left + gap)}px;`
			: "left: 8px;";
		const panelStyle = `position: fixed; ${side} bottom: ${bottom}px; max-height: ${maxH}px; box-shadow: var(--sapContent_Shadow2, 0 6px 20px rgba(0,0,0,0.18)); font-family: var(--sapFontFamily, inherit);`;

		return html`
			<div
				class="z-[1000] w-72 overflow-y-auto rounded-md border border-border bg-popover py-1 text-sm text-popover-foreground"
				style=${panelStyle}
				@click=${(e: Event) => e.stopPropagation()}
			>
				${this.skills.length === 0
					? html`<div class="px-3 py-1.5 text-xs text-muted-foreground">${i18n("No skills yet")}</div>`
					: this.skills.map(
							(skill) => html`
								<button
									type="button"
									class="block w-full px-3 py-1.5 text-left hover:bg-accent"
									@click=${() => {
										this.closeAttachMenu();
										this.insertTextAtCaret(`/${skill.name} `);
									}}
									title=${skill.description ?? skill.name}
								>
									<span class="block truncate font-medium">/${skill.name}</span>
									${skill.description
										? html`<span class="block truncate text-xs text-muted-foreground">${skill.description}</span>`
										: ""}
								</button>
							`,
						)}
				${this.onSkillUpload
					? html`
						<div class="my-1 h-px bg-border"></div>
						<button
							type="button"
							class=${rowClass}
							@click=${() => {
								this.closeAttachMenu();
								this.onSkillUpload?.();
							}}
						>
							${icon(Upload, "sm")}<span class="flex-1">${i18n("Browser Skills")}</span>
						</button>
					`
					: ""}
			</div>
		`;
	}

	private renderFolderDialogContent() {
		const pick = this.folderPick;
		if (!pick) return html``;
		const close = () => {
			this.folderPick = null;
		};
		const shownSkipped = pick.skipped.slice(0, 5);
		return html`
			<div class="fixed inset-0 z-[1001] flex items-center justify-center bg-black/40 p-4" @click=${close}>
				<div
					class="w-[26rem] max-w-full rounded-lg border border-border bg-popover p-4 text-sm text-popover-foreground"
					style="box-shadow: var(--sapContent_Shadow2, 0 6px 20px rgba(0,0,0,0.18)); font-family: var(--sapFontFamily, inherit);"
					@click=${(e: Event) => e.stopPropagation()}
				>
					<div class="mb-1 font-semibold">${i18n("Add folder")}</div>
					<div class="mb-3 truncate text-muted-foreground">${pick.folderName}</div>
					${pick.error
						? html`<div class="mb-3 text-destructive">${pick.error}</div>`
						: html`<div class="mb-3">${pick.entries.length} ${i18n("files")} · ${formatBytes(pick.bytes)}</div>`}
					${pick.skipped.length > 0
						? html`
							<div class="mb-3 text-xs text-muted-foreground">
								<div>${pick.skipped.length} ${i18n("files skipped")}</div>
								${shownSkipped.map((path) => html`<div class="truncate">${path}</div>`)}
								${pick.skipped.length > shownSkipped.length ? html`<div>…</div>` : ""}
							</div>
						`
						: ""}
					<div class="flex justify-end gap-2">
						${Button({ variant: "ghost", size: "sm", onClick: close, children: i18n("Cancel") })}
						${Button({
							variant: "default",
							size: "sm",
							onClick: () => void this.confirmFolderPick(),
							disabled: pick.error !== "" || this.processingFiles,
							children: i18n("Attach"),
						})}
					</div>
				</div>
			</div>
		`;
	}

	private syncQuickMenuPortal() {
		if (this.useQuickSelector && this.quickMenuOpen) {
			if (!this.menuPortal) {
				this.menuPortal = document.createElement("div");
				document.body.appendChild(this.menuPortal);
			}
			litRender(this.renderQuickMenuContent(), this.menuPortal);
		} else if (this.menuPortal) {
			litRender(html``, this.menuPortal);
			this.menuPortal.remove();
			this.menuPortal = undefined;
		}
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		document.removeEventListener("selectionchange", this.handleSelectionChange);
		for (const portal of [
			this.menuPortal,
			this.attachMenuPortal,
			this.folderDialogPortal,
			this.mentionPortal,
			this.skillPortal,
		]) {
			if (!portal) continue;
			litRender(html``, portal);
			portal.remove();
		}
		this.menuPortal = undefined;
		this.attachMenuPortal = undefined;
		this.folderDialogPortal = undefined;
		this.mentionPortal = undefined;
		this.skillPortal = undefined;
	}

	private renderQuickMenuContent() {
		const selected = this.quickModels.find((m) => m.value === this.selectedModelValue);
		const modelLabel = selected?.label ?? i18n("None");
		const closeMenu = () => {
			this.quickMenuOpen = false;
			this.quickSubmenuOpen = false;
		};
		const pickModel = (value: string) => {
			this.onModelChange?.(value);
			closeMenu();
		};
		const a = this.quickMenuAnchor;
		const right = a ? Math.max(8, Math.round(window.innerWidth - a.right)) : 8;
		const bottom = a ? Math.round(window.innerHeight - a.top + 8) : 64;
		const maxH = a ? Math.max(180, Math.round(a.top - 16)) : 360;
		const panelStyle = `position: fixed; right: ${right}px; bottom: ${bottom}px; max-height: ${maxH}px; box-shadow: var(--sapContent_Shadow2, 0 6px 20px rgba(0,0,0,0.18)); font-family: var(--sapFontFamily, inherit);`;
		return html`
			<div class="fixed inset-0 z-[999]" @click=${closeMenu}></div>
			<div
				class="z-[1000] w-64 overflow-y-auto rounded-md border border-border bg-popover py-1 text-sm text-popover-foreground"
				style=${panelStyle}
				@click=${(e: Event) => e.stopPropagation()}
			>
				<div class="px-3 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">${i18n("Reasoning")}</div>
				${REASONING_LEVELS.map((lvl) => {
					const active = String(this.thinkingLevel) === lvl.value;
					return html`
						<button
							type="button"
							class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent ${active ? "text-accent-foreground" : ""}"
							@click=${() => this.onThinkingChange?.(lvl.value)}
						>
							<span class="flex-1">${lvl.label}</span>
							${active ? icon(Check, "sm") : ""}
						</button>
					`;
				})}
				<div class="my-1 h-px bg-border"></div>
				<button
					type="button"
					class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent"
					@click=${() => {
						this.quickSubmenuOpen = !this.quickSubmenuOpen;
					}}
				>
					<span class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">${i18n("Model")}</span>
					<span class="ml-auto min-w-0 truncate text-muted-foreground">${modelLabel}</span>
					${icon(this.quickSubmenuOpen ? ChevronDown : ChevronRight, "sm")}
				</button>
				${this.quickSubmenuOpen
					? html`
						<div class="border-t border-border">
							<button
								type="button"
								class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent ${this.selectedModelValue === "" ? "text-accent-foreground" : ""}"
								@click=${() => pickModel("")}
							>
								<span class="flex-1">${i18n("None")}</span>
								${this.selectedModelValue === "" ? icon(Check, "sm") : ""}
							</button>
							${this.quickModels.map((m) => {
								const active = this.selectedModelValue === m.value;
								return html`
									<button
										type="button"
										class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent ${active ? "text-accent-foreground" : ""}"
										@click=${() => pickModel(m.value)}
									>
										<span class="min-w-0 flex-1 truncate">${m.label}</span>
										<span class="shrink-0 text-xs text-muted-foreground">${m.provider}</span>
										${active ? icon(Check, "sm") : ""}
									</button>
								`;
							})}
						</div>
					`
					: ""}
			</div>
		`;
	}

	override render() {
		// Check if current model supports thinking/reasoning
		const model = this.currentModel;
		const supportsThinking = model?.reasoning === true; // Models with reasoning:true support thinking

		return html`
			<div
				class="bg-card rounded-xl border shadow-sm relative ${this.isDragging ? "border-primary border-2 bg-primary/5" : "border-border"}"
				${ref(this.composerRef)}
				@dragover=${this.handleDragOver}
				@dragleave=${this.handleDragLeave}
				@drop=${this.handleDrop}
			>
				<!-- Drag overlay -->
				${
					this.isDragging
						? html`
					<div class="absolute inset-0 bg-primary/10 rounded-xl pointer-events-none z-10 flex items-center justify-center">
						<div class="text-primary font-medium">${i18n("Drop files here")}</div>
					</div>
				`
						: ""
				}

				<!-- Attachments. A folder can add dozens at once, so the list collapses. -->
				${
					this.attachments.length > 0
						? html`
							<div class="px-4 pt-3 pb-2 flex flex-wrap gap-2 items-center">
								${(this.attachmentsExpanded ? this.attachments : this.attachments.slice(0, VISIBLE_ATTACHMENTS)).map(
									(attachment) => html`
										<attachment-tile
											.attachment=${attachment}
											.showDelete=${true}
											.onDelete=${() => this.removeFile(attachment.id)}
										></attachment-tile>
									`,
								)}
								${this.attachments.length > VISIBLE_ATTACHMENTS
									? html`
										<button
											type="button"
											class="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
											@click=${() => {
												this.attachmentsExpanded = !this.attachmentsExpanded;
											}}
										>
											${this.attachmentsExpanded
												? i18n("Show less")
												: `+${this.attachments.length - VISIBLE_ATTACHMENTS} ${i18n("more")}`}
										</button>
									`
									: ""}
							</div>
						`
						: ""
				}

				<textarea
					class="w-full bg-transparent p-4 text-foreground placeholder-muted-foreground outline-none resize-none overflow-y-auto"
					placeholder=${i18n("Type a message...")}
					rows="1"
					style="max-height: 200px; field-sizing: content; min-height: 1lh; height: auto;"
					.value=${this.value}
					@input=${this.handleTextareaInput}
					@keydown=${this.handleKeyDown}
					@paste=${this.handlePaste}
					${ref(this.textareaRef)}
				></textarea>

				<!-- Hidden file input -->
				<input
					type="file"
					${ref(this.fileInputRef)}
					@change=${this.handleFilesSelected}
					accept=${this.acceptedTypes}
					multiple
					style="display: none;"
				/>

				<!-- Hidden folder input. No accept: folder pickers ignore it, so the
				     filtering happens in handleFolderSelected instead. -->
				<input
					type="file"
					${ref(this.folderInputRef)}
					@change=${this.handleFolderSelected}
					webkitdirectory
					multiple
					style="display: none;"
				/>

				<!-- Button Row -->
				<div class="px-2 pb-2 flex items-center justify-between">
					<!-- Left side - attachment and thinking selector -->
					<div class="flex gap-2 items-center">
						${
							this.showAttachmentButton
								? this.processingFiles
									? html`
									<div class="h-8 w-8 flex items-center justify-center">
										${icon(Loader2, "sm", "animate-spin text-muted-foreground")}
									</div>
								`
									: html`
									<div class="relative" ${ref(this.attachAnchorRef)}>
										${Button({
											variant: "ghost",
											size: "icon",
											className: "h-8 w-8",
											onClick: () => this.toggleAttachMenu(),
											children: icon(this.useQuickSelector ? Plus : Paperclip, "sm"),
										})}
									</div>
								`
								: ""
						}
						${
							supportsThinking && this.showThinkingSelector && !this.useQuickSelector
								? html`
								${Select({
									value: this.thinkingLevel,
									placeholder: i18n("Off"),
									options: [
										{ value: "off", label: i18n("Off"), icon: icon(Brain, "sm") },
										{ value: "minimal", label: i18n("Minimal"), icon: icon(Brain, "sm") },
										{ value: "low", label: i18n("Low"), icon: icon(Brain, "sm") },
										{ value: "medium", label: i18n("Medium"), icon: icon(Brain, "sm") },
										{ value: "high", label: i18n("High"), icon: icon(Brain, "sm") },
									] as SelectOption[],
									onChange: (value: string) => {
										this.onThinkingChange?.(value as "off" | "minimal" | "low" | "medium" | "high");
									},
									width: "80px",
									size: "sm",
									variant: "ghost",
									fitContent: true,
								})}
							`
								: ""
						}
					</div>

					<!-- Model selector and send on the right -->
					<div class="flex gap-2 items-center">
						${this.useQuickSelector ? this.renderQuickSelector() : ""}
						${
							!this.useQuickSelector && this.showModelSelector && this.currentModel
								? html`
								${Button({
									variant: "ghost",
									size: "sm",
									onClick: () => {
										// Focus textarea before opening model selector so focus returns there
										this.textareaRef.value?.focus();
										// Wait for next frame to ensure focus takes effect before dialog captures it
										requestAnimationFrame(() => {
											this.onModelSelect?.();
										});
									},
									children: html`
										${icon(Sparkles, "sm")}
										<span class="ml-1">${this.currentModel.id}</span>
									`,
									className: "h-8 text-xs truncate",
								})}
							`
								: ""
						}
						${
							this.isStreaming
								? html`
								${Button({
									variant: "ghost",
									size: "icon",
									onClick: this.onAbort,
									children: icon(Square, "sm"),
									className: "h-8 w-8",
								})}
							`
								: this.useQuickSelector
									? html`
										<button
											type="button"
											class="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
											?disabled=${(!this.value.trim() && this.attachments.length === 0) || this.processingFiles || !this.selectedModelValue}
											@click=${this.handleSend}
											title=${i18n("Send")}
										>
											${icon(ArrowUp, "sm")}
										</button>
									`
									: html`
								${Button({
									variant: "ghost",
									size: "icon",
									onClick: this.handleSend,
									disabled: (!this.value.trim() && this.attachments.length === 0) || this.processingFiles,
									children: html`<div style="transform: rotate(-45deg)">${icon(Send, "sm")}</div>`,
									className: "h-8 w-8",
								})}
							`
						}
					</div>
				</div>
			</div>
		`;
	}
}
