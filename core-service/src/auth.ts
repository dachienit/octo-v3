import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import type express from "express";
import { isXsuaaEnabled, verifyXsuaaToken } from "./xsuaa.js";
import { type AuthStorage, type AuthUser, createAuthStorage } from "./auth-storage.js";

export type { AuthUser } from "./auth-storage.js";

declare global {
	namespace Express {
		interface User extends AuthUser {}
	}
}

export class CoreServiceAuth {
	private store!: AuthStorage;
	private readonly dataRoot: string;

	getStore(): AuthStorage {
		return this.store;
	}

	constructor(dataRoot: string) {
		this.dataRoot = dataRoot;
	}

	async init(): Promise<void> {
		this.store = await createAuthStorage({ dataRoot: this.dataRoot });
		passport.use(
			new LocalStrategy(
				{ usernameField: "email", passwordField: "password", session: false },
				async (email, password, done) => {
					try {
						const user = await this.store.verifyPassword(email, password);
						return done(null, user || false, user ? undefined : { message: "Invalid email or password" });
					} catch (err) {
						return done(err);
					}
				},
			),
		);
	}

	initialize(): express.Handler {
		return passport.initialize();
	}

	async register(req: express.Request, res: express.Response): Promise<void> {
		const allowSignup = process.env.CORE_SERVICE_ALLOW_SIGNUP !== "false" || (await this.store.userCount()) === 0;		if (!allowSignup) {
			res.status(403).json({ error: "Signup is disabled" });
			return;
		}
		const { email, password, displayName } = req.body as { email?: string; password?: string; displayName?: string };
		try {
			const user = await this.store.createUser({ email: email || "", password: password || "", displayName });
			const session = await this.store.createToken(user.id);
			this.setAuthCookie(res, session.token, session.expiresAt);
			res.status(201).json({ user, token: session.token, expiresAt: session.expiresAt });
		} catch (err) {
			res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	login(req: express.Request, res: express.Response, next: express.NextFunction): void {
		passport.authenticate("local", { session: false }, async (err: unknown, user?: AuthUser | false, info?: { message?: string }) => {
			if (err) return next(err);
			if (!user) {
				res.status(401).json({ error: info?.message || "Invalid email or password" });
				return;
			}
			const session = await this.store.createToken(user.id);
			this.setAuthCookie(res, session.token, session.expiresAt);
			res.json({ user, token: session.token, expiresAt: session.expiresAt });
		})(req, res, next);
	}

	async completeFederatedLogin(
		res: express.Response,
		identity: { provider: string; subject: string; email: string; displayName?: string; avatarUrl?: string },
	): Promise<{ user: AuthUser; token: string; expiresAt: string }> {
		const user = await this.store.upsertFederatedUser(identity);
		const session = await this.store.createToken(user.id);
		this.setAuthCookie(res, session.token, session.expiresAt);
		return { user, token: session.token, expiresAt: session.expiresAt };
	}

	async logout(req: express.Request, res: express.Response): Promise<void> {
		const token = this.extractBearerToken(req);
		if (token) await this.store.revokeToken(token);
		res.setHeader("Set-Cookie", "pi_auth_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
		res.json({ ok: true });
	}

	me(req: express.Request, res: express.Response): void {
		res.json({ user: req.user });
	}

	private xsuaaUserCache = new Map<string, { user: AuthUser; exp: number }>();

	private async resolveXsuaaUser(token: string): Promise<AuthUser | undefined> {
		const identity = await verifyXsuaaToken(token);
		if (!identity) return undefined;
		const cached = this.xsuaaUserCache.get(identity.subject);
		if (cached && cached.exp > Date.now()) return cached.user;
		const user = await this.store.upsertFederatedUser(identity);
		this.xsuaaUserCache.set(identity.subject, { user, exp: Date.now() + 5 * 60_000 });
		return user;
	}

	async requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
		const token = this.extractBearerToken(req);
		if (!token) {
			res.status(401).json({ error: "Authentication required" });
			return;
		}
		if (isXsuaaEnabled()) {
			try {
				const xsuaaUser = await this.resolveXsuaaUser(token);
				if (xsuaaUser) {
					req.user = xsuaaUser;
					next();
					return;
				}
			} catch {
				// Not a valid XSUAA token — fall through to the opaque-token path below.
			}
		}
		const user = await this.store.getUserByToken(token);
		if (!user) {
			res.status(401).json({ error: "Invalid or expired token" });
			return;
		}
		req.user = user;
		next();
	}

	private extractBearerToken(req: express.Request): string | undefined {
		const header = req.header("Authorization");
		const match = header?.match(/^Bearer\s+(.+)$/i);
		if (match?.[1]) return match[1].trim();
		const cookie = req.header("Cookie") || "";
		const tokenCookie = cookie
			.split(";")
			.map((part) => part.trim())
			.find((part) => part.startsWith("pi_auth_token="));
		return tokenCookie ? decodeURIComponent(tokenCookie.slice("pi_auth_token=".length)) : undefined;
	}

	private setAuthCookie(res: express.Response, token: string, expiresAt: string): void {
		const maxAge = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
		res.setHeader(
			"Set-Cookie",
			`pi_auth_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
		);
	}
}
