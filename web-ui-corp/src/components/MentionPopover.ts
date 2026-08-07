/**
 * The `@`-mention picker.
 *
 * Rendered through a `document.body` portal by its host rather than inline, because
 * the composer card clips overflow — the same reason `MessageEditor`'s quick menu
 * portals itself. It is anchored above the composer (Slack/Discord style) instead
 * of at the caret: a textarea gives no caret coordinates without a mirror-div, and
 * a full-width panel has room for long paths.
 *
 * Light DOM, like every component in this package, so Tailwind and the Fiori theme
 * tokens reach it.
 */

import { icon } from "@mariozechner/mini-lit";
import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { createRef, ref } from "lit/directives/ref.js";
import { File, FileArchive, FileAudio, FileCode, FileCog, FileImage, FileJson, FilePlay, FileSpreadsheet, FileText, Folder, Presentation } from "lucide";
import type { MentionCandidate } from "../utils/mention-utils.js";
import { i18n } from "../utils/i18n.js";

const FILE_EXT_ICON: Record<string, typeof File> = {
	ts: FileCode, tsx: FileCode, js: FileCode, jsx: FileCode, mjs: FileCode, cjs: FileCode,
	py: FileCode, java: FileCode, abap: FileCode, cds: FileCode, csn: FileCode,
	xml: FileCode, sql: FileCode, c: FileCode, cpp: FileCode, h: FileCode, go: FileCode, rs: FileCode,
	json: FileJson, jsonl: FileJson,
	md: FileText, markdown: FileText, txt: FileText, log: FileText, pdf: FileText, doc: FileText, docx: FileText,
	csv: FileSpreadsheet, tsv: FileSpreadsheet, xls: FileSpreadsheet, xlsx: FileSpreadsheet,
	yaml: FileCog, yml: FileCog, toml: FileCog, ini: FileCog, env: FileCog,
	png: FileImage, jpg: FileImage, jpeg: FileImage, gif: FileImage, svg: FileImage, webp: FileImage, bmp: FileImage, ico: FileImage,
	zip: FileArchive, gz: FileArchive, tar: FileArchive, tgz: FileArchive, "7z": FileArchive, rar: FileArchive,
	ppt: Presentation, pptx: Presentation,
	mp3: FileAudio, wav: FileAudio, ogg: FileAudio, m4a: FileAudio,
	mp4: FilePlay, mov: FilePlay, avi: FilePlay, webm: FilePlay, mkv: FilePlay,
};

export function mentionIconFor(candidate: MentionCandidate): typeof File {
	if (candidate.type === "directory") return Folder;
	const ext = candidate.name.split(".").pop()?.toLowerCase() ?? "";
	return FILE_EXT_ICON[ext] ?? File;
}

/**
 * A directory reads as `abc/`. The slash is the affordance: it says the row is a step
 * into something rather than a thing to tag, and it is literally what gets inserted.
 */
export function mentionLabel(candidate: MentionCandidate): string {
	return candidate.type === "directory" ? `${candidate.name}/` : candidate.name;
}

@customElement("mention-popover")
export class MentionPopover extends LitElement {
	@property({ attribute: false }) declare items: MentionCandidate[];
	@property({ attribute: false }) declare selectedIndex: number;
	/** Bounding rect of the composer, so the panel can sit directly above it. */
	@property({ attribute: false }) declare anchor: DOMRect | null;
	@property({ attribute: false }) declare onPick: ((candidate: MentionCandidate) => void) | undefined;
	@property({ attribute: false }) declare onDismiss: (() => void) | undefined;
	@property({ attribute: false }) declare onHoverIndex: ((index: number) => void) | undefined;

	private listRef = createRef<HTMLDivElement>();

	constructor() {
		super();
		this.items = [];
		this.selectedIndex = 0;
		this.anchor = null;
		this.onPick = undefined;
		this.onDismiss = undefined;
		this.onHoverIndex = undefined;
	}

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override updated() {
		// Keyboard navigation must drag the viewport with it; `nearest` avoids the
		// jumpiness of centering on every arrow press.
		const list = this.listRef.value;
		const active = list?.querySelector<HTMLElement>("[data-mention-item][data-active='true']");
		active?.scrollIntoView({ block: "nearest" });
	}

	override render() {
		const a = this.anchor;
		const left = a ? Math.round(a.left) : 16;
		const width = a ? Math.round(a.width) : 360;
		const bottom = a ? Math.round(window.innerHeight - a.top + 8) : 96;
		const maxH = a ? Math.max(140, Math.round(a.top - 24)) : 320;
		const panelStyle = `position: fixed; left: ${left}px; width: ${width}px; bottom: ${bottom}px; max-height: ${maxH}px; box-shadow: var(--sapContent_Shadow2, 0 6px 20px rgba(0,0,0,0.18)); font-family: var(--sapFontFamily, inherit);`;

		return html`
			<div class="fixed inset-0 z-[999]" @mousedown=${() => this.onDismiss?.()}></div>
			<div
				class="z-[1000] overflow-y-auto rounded-md border border-border bg-popover py-1 text-sm text-popover-foreground"
				style=${panelStyle}
				${ref(this.listRef)}
				@mousedown=${(e: Event) => e.preventDefault()}
			>
				${
					this.items.length === 0
						? html`<div class="px-3 py-2 text-muted-foreground">${i18n("No matching files")}</div>`
						: this.items.map((candidate, index) => {
								const active = index === this.selectedIndex;
								return html`
									<button
										type="button"
										data-mention-item
										data-active=${active ? "true" : "false"}
										class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent ${active ? "bg-accent text-accent-foreground" : ""}"
										@mouseenter=${() => this.onHoverIndex?.(index)}
										@click=${() => this.onPick?.(candidate)}
									>
										<span class="shrink-0 text-muted-foreground">${icon(mentionIconFor(candidate), "sm")}</span>
										<span class="min-w-0 flex-1 truncate">${mentionLabel(candidate)}</span>
										<span class="shrink-0 truncate text-xs text-muted-foreground">${scopeLabel(candidate)}</span>
									</button>
								`;
							})
				}
			</div>
		`;
	}
}

/** Shows where a hit lives, so two files with the same name stay distinguishable. */
function scopeLabel(candidate: MentionCandidate): string {
	if (candidate.scope === "attachments") return i18n("attachments");
	const parent = candidate.path.split("/").slice(0, -1).join("/");
	return parent ? `artifacts/${parent}` : "artifacts";
}

declare global {
	interface HTMLElementTagNameMap {
		"mention-popover": MentionPopover;
	}
}
