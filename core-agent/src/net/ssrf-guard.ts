/**
 * Server-side request forgery guard for the web tools.
 *
 * `core-service` runs next to internal services — on BTP Cloud Foundry it sits
 * inside the landscape and reads `VCAP_SERVICES` — so an unrestricted fetch tool
 * would let a prompt reach cloud metadata endpoints and internal APIs. Every URL
 * is therefore resolved and every resulting address checked before a request is
 * made, and again after each redirect hop.
 *
 * This also keeps `web_fetch` from becoming a way around the standing rule that
 * on-premise SAP systems are reached only through the BTP Destination and the
 * `sap-adt` connector, never by direct network calls.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { hasProxyConfigured } from "./proxy.js";

/** Hostnames that always resolve to the local machine or a private namespace. */
const BLOCKED_HOST_SUFFIXES = [".internal", ".local", ".localdomain", ".localhost", ".cluster.local"];
const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata", "metadata.google.internal", "instance-data"]);

export class BlockedUrlError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BlockedUrlError";
	}
}

function isBlockedIpv4(ip: string): boolean {
	const parts = ip.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
	const [a, b] = parts;
	if (a === 0) return true; // "this network"
	if (a === 10) return true; // private
	if (a === 127) return true; // loopback
	if (a === 169 && b === 254) return true; // link-local, includes cloud metadata
	if (a === 172 && b >= 16 && b <= 31) return true; // private
	if (a === 192 && b === 168) return true; // private
	if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
	if (a >= 224) return true; // multicast and reserved
	return false;
}

function isBlockedIpv6(ip: string): boolean {
	const address = ip.toLowerCase().split("%")[0];
	if (address === "::" || address === "::1") return true;

	const mapped = /^(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/.exec(address);
	if (mapped) return isBlockedIpv4(mapped[1]);

	if (/^fe[89ab]/.test(address)) return true; // link-local fe80::/10
	if (/^f[cd]/.test(address)) return true; // unique local fc00::/7
	if (address.startsWith("ff")) return true; // multicast
	return false;
}

function isBlockedAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return isBlockedIpv4(address);
	if (family === 6) return isBlockedIpv6(address);
	return true;
}

function isBlockedHostname(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
	if (BLOCKED_HOSTNAMES.has(host)) return true;
	return BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Validates a URL and the addresses its host resolves to. Throws
 * `BlockedUrlError` when the target is not a public HTTP(S) endpoint.
 */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new BlockedUrlError(`Not a valid URL: ${rawUrl}`);
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new BlockedUrlError(`Only http and https URLs are supported, got ${url.protocol}`);
	}
	if (url.username || url.password) {
		throw new BlockedUrlError("URLs with embedded credentials are not allowed");
	}

	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	if (isBlockedHostname(url.hostname)) {
		throw new BlockedUrlError(
			`Refusing to fetch ${url.hostname}: private and internal hostnames are blocked. Internal SAP systems must be reached through the configured Destination and the sap-adt connector.`,
		);
	}

	// A literal IP needs no resolution; anything else is resolved so a public name
	// pointing at a private address is caught too.
	if (isIP(hostname)) {
		if (isBlockedAddress(hostname)) {
			throw new BlockedUrlError(`Refusing to fetch ${url.hostname}: address is in a private or reserved range`);
		}
		return url;
	}

	let addresses: Array<{ address: string }>;
	try {
		addresses = await lookup(hostname, { all: true });
	} catch (cause) {
		// Behind a corporate proxy the client often cannot resolve public names at
		// all — name resolution is the proxy's job. Failing here would make the web
		// tools unusable in exactly the environment Octo runs in, so a resolution
		// failure is only fatal when there is no proxy to defer to. The hostname
		// checks above have already run either way.
		if (hasProxyConfigured()) return url;
		throw new BlockedUrlError(`Could not resolve ${url.hostname}: ${cause instanceof Error ? cause.message : String(cause)}`);
	}

	if (addresses.length === 0) {
		if (hasProxyConfigured()) return url;
		throw new BlockedUrlError(`Could not resolve ${url.hostname}`);
	}
	const blocked = addresses.find((entry) => isBlockedAddress(entry.address));
	if (blocked) {
		throw new BlockedUrlError(
			`Refusing to fetch ${url.hostname}: it resolves to ${blocked.address}, which is in a private or reserved range. Internal systems must be reached through the configured Destination and the sap-adt connector.`,
		);
	}

	return url;
}
