import { html, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ArtifactElement } from "./ArtifactElement.js";
import { createRoot, type Root } from "react-dom/client";
import React from "react";
import { DocxViewerPreview } from "../../components/ui/docx-viewer.js";
import { i18n } from "../../utils/i18n.js";
import { DownloadButton } from "@mariozechner/mini-lit/dist/DownloadButton.js";

@customElement("docx-artifact")
export class DocxArtifact extends ArtifactElement {
        @property({ type: String }) private _content = "";
        private reactRoot?: Root;

        get content(): string {
                return this._content;
        }

        set content(value: string) {
                this._content = value;
                this.requestUpdate();
        }

        protected override createRenderRoot(): HTMLElement | DocumentFragment {
                return this;
        }

        override connectedCallback(): void {
                super.connectedCallback();
                this.style.display = "block";
                this.style.height = "100%";
        }

        override disconnectedCallback(): void {
                super.disconnectedCallback();
                if (this.reactRoot) {
                        this.reactRoot.unmount();
                        this.reactRoot = undefined;
                }
        }

        private decodeBase64(): Uint8Array {
                let base64Data = this._content;
                if (this._content.startsWith("data:")) {
                        const base64Match = this._content.match(/base64,(.+)/);
                        if (base64Match) {
                                base64Data = base64Match[1];
                        }
                }

                const binaryString = atob(base64Data);
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                }
                return bytes;
        }

        private getMimeType(): string {
                return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        }

        public getHeaderButtons() {
                return html`<div class="flex items-center gap-1">${DownloadButton({ content: this.decodeBase64(), filename: this.filename, mimeType: this.getMimeType(), title: i18n("Download") }) }</div>`;
        }

        override render(): TemplateResult {
                return html`<div id="react-preview-container" class="bg-card text-foreground overflow-auto shadow-lg border border-border w-full h-full"></div>`;
        }

        override updated(changedProperties: Map<string, any>) {
                super.updated(changedProperties);

                const container = this.querySelector("#react-preview-container") as HTMLDivElement;
                if (!container || !this._content) return;

                if (!this.reactRoot) {
                        this.reactRoot = createRoot(container);
                }

                let url = this._content;
                if (!url.startsWith("data:")) {
                        url = "data:" + this.getMimeType() + ";base64," + this._content;
                }

                const isDark = document.documentElement.classList.contains("dark");

                this.reactRoot.render(
                        React.createElement(DocxViewerPreview, {
                                src: url,
                                fileName: this.filename,
                                isDark: isDark,
                                onIsDarkChange: (dark: boolean) => {
                                        if (dark) {
                                                document.documentElement.classList.add("dark");
                                        } else {
                                                document.documentElement.classList.remove("dark");
                                        }
                                },
                                showDownload: true,
                                showToolbar: true,
                                showUpload: false
                        })
                );
        }
}

declare global {
        interface HTMLElementTagNameMap {
                "docx-artifact": DocxArtifact;
        }
}
