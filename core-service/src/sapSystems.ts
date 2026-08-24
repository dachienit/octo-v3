// Corporate SAP system catalogue — the picklist behind the "On-Premise (SSO)"
// connect form.
//
// Source of truth is `octo-v2/sap-systems.json`, generated from the corporate
// SAPUILandscapeGlobal.xml. Each entry already carries everything a `basicsso`
// profile needs, so the UI only has to let the user pick a system and type a
// client: the ADT base URL and the Kerberos SPN are derived here, server-side,
// and never travel from the browser.
//
// This replaces the per-machine SAP Logon scan (see sapLandscape.ts) as the list
// source: the catalogue is the full corporate landscape rather than whatever the
// developer happens to have configured locally.

import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

export interface SapCatalogSystem {
	/** 3-character system id, e.g. S1R. */
	name: string;
	description: string;
	/** ADT base URL, e.g. https://s1r.wdisp.bosch.com (no trailing path). */
	URL: string;
	/** Message-server host; empty for a handful of entries in the landscape. */
	host: string;
	port: string;
	/** Kerberos service principal, e.g. SAP/S1RSNCAD. */
	spn: string;
}

const CATALOG_FILE = "sap-systems.json";

// Default sap-client when the user does not override it in the connect form.
export const DEFAULT_SAP_CLIENT = "011";
// Default sap-language; not exposed in the form, ADT needs one.
export const DEFAULT_SAP_LANGUAGE = "EN";

let cache: SapCatalogSystem[] | undefined;

// dist/sapSystems.js -> the repo root sits two levels up in dev, one level up in
// the assembled deploy folder (which mirrors core-service with dist/ inside).
function candidatePaths(): string[] {
	const here = dirname(fileURLToPath(import.meta.url));
	const out: string[] = [];
	if (process.env.SAP_SYSTEMS_FILE) out.push(process.env.SAP_SYSTEMS_FILE);
	out.push(join(here, "..", "..", CATALOG_FILE));
	out.push(join(here, "..", CATALOG_FILE));
	return out;
}

function isSystem(value: unknown): value is SapCatalogSystem {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return typeof v.name === "string" && v.name.length > 0 && typeof v.URL === "string" && typeof v.spn === "string";
}

/**
 * The full corporate landscape, in file order. Read once and cached; returns []
 * when the catalogue file is missing or unreadable so the connect form degrades
 * to "no systems found" instead of failing the request.
 */
export function listSapCatalogSystems(): SapCatalogSystem[] {
	if (cache) return cache;
	for (const path of candidatePaths()) {
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
			if (!Array.isArray(parsed)) continue;
			// Normalize here so every consumer sees the same clean strings. The
			// generated landscape carries stray trailing spaces and tabs on a handful
			// of descriptions; the connect form builds its picklist label from
			// `name — description` and matches the value the combobox hands back
			// against that label, so a single trailing space made those systems
			// impossible to select. Whitespace inside a URL would break `new URL()`
			// on the adt-cli side, so trim those too.
			cache = parsed.filter(isSystem).map((s) => ({
				name: s.name.trim(),
				description: (s.description ?? "").replace(/\s+/g, " ").trim(),
				URL: s.URL.trim(),
				host: (s.host ?? "").trim(),
				port: (s.port ?? "").trim(),
				spn: s.spn.trim(),
			}));
			return cache;
		} catch {
			/* malformed catalogue -> try the next candidate */
		}
	}
	cache = [];
	return cache;
}

/**
 * Look up a system by its 3-character id. The landscape has one duplicated id
 * (P11), so this returns the first match — matching what the picklist shows.
 */
export function findSapCatalogSystem(name: string): SapCatalogSystem | undefined {
	const wanted = name.trim().toUpperCase();
	if (!wanted) return undefined;
	return listSapCatalogSystems().find((s) => s.name.toUpperCase() === wanted);
}
