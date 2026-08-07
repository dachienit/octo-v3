// Product branding, resolved from the environment so a deployment can rebrand the
// app without a rebuild.
//
// These are functions, not module-level constants: main.ts hydrates process.env
// from the VCAP_SERVICES user-provided credentials only after the whole module
// graph has been imported, so a const evaluated at import time could read a stale
// (unset) value.

/** Fallback product name when nothing is configured. */
const DEFAULT_APP_TITLE = "Octo";

/** Browser tab title, chat agent name, and the name the agent uses for itself. */
export function getAppTitle(): string {
	return (process.env.CORE_SERVICE_APP_TITLE ?? "").trim() || DEFAULT_APP_TITLE;
}

/** Label in the web app header bar. Falls back to the app title. */
export function getAppHeader(): string {
	return (process.env.CORE_SERVICE_APP_HEADER ?? "").trim() || getAppTitle();
}
