/**
 * The `/` skill picker.
 *
 * Same shape as `MentionPopover` — portalled by its host because the composer card clips
 * overflow, anchored above the composer rather than at the caret, light DOM so Tailwind
 * and the Fiori tokens reach it. Only the row differs: a skill is chosen by what it does,
 * so the description sits under the name instead of a path.
 */

import { icon } from "@mariozechner/mini-lit";
import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { createRef, ref } from "lit/directives/ref.js";
import { Sparkles } from "lucide";
import { i18n } from "../utils/i18n.js";
import type { ComposerSkill } from "../utils/skill-utils.js";

@customElement("skill-popover")
export class SkillPopover extends LitElement {
	@property({ attribute: false }) declare items: ComposerSkill[];
	@property({ attribute: false }) declare selectedIndex: number;
	/** Bounding rect of the composer, so the panel can sit directly above it. */
	@property({ attribute: false }) declare anchor: DOMRect | null;
	@property({ attribute: false }) declare onPick: ((skill: ComposerSkill) => void) | undefined;
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
		const active = list?.querySelector<HTMLElement>("[data-skill-item][data-active='true']");
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
						? html`<div class="px-3 py-2 text-muted-foreground">${i18n("No matching skills")}</div>`
						: this.items.map((skill, index) => {
								const active = index === this.selectedIndex;
								return html`
									<button
										type="button"
										data-skill-item
										data-active=${active ? "true" : "false"}
										class="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-accent ${active ? "bg-accent text-accent-foreground" : ""}"
										@mouseenter=${() => this.onHoverIndex?.(index)}
										@click=${() => this.onPick?.(skill)}
									>
										<span class="mt-0.5 shrink-0 text-muted-foreground">${icon(Sparkles, "sm")}</span>
										<span class="min-w-0 flex-1">
											<span class="block truncate font-medium">/${skill.name}</span>
											${skill.description
												? html`<span class="block truncate text-xs text-muted-foreground">${skill.description}</span>`
												: ""}
										</span>
									</button>
								`;
							})
				}
			</div>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"skill-popover": SkillPopover;
	}
}
