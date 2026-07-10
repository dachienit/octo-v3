import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { fileURLToPath } from "url";

export default defineConfig({
	plugins: [tailwindcss()],
	//IYH1HC add: xlsx viewer (@extend-ai/react-xlsx) ships a worker that uses code-splitting;
	// Vite's default worker.format "iife" rejects code-split workers, so build workers as ES.
	worker: {
		format: "es",
	},
	resolve: {
		alias: {
			"@octo/web-ui-corp": fileURLToPath(new URL("../web-ui-corp/src/index.ts", import.meta.url)),
		},
		dedupe: ["@mariozechner/mini-lit", "lit"],
	},
	server: {
		proxy: {
			"/api": {
				target: "http://localhost:3030",
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/api/, ""),
			},
		},
	},
});
