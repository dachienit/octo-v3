import { configureFioriTheme, CoreServiceChatPanel, CoreServiceClient, DEFAULT_APP_TITLE, fileToBase64, translations, type AcpJob, type AuthUser, type ConnectorStatus, type CoreServiceFeatures, type CustomModelConfig, type LlmConfig, type SapDestination, type SapLocalSystem, type SapTreeManifestEntry, type SessionInfo, type SkillUploadFile, type SsoConfig, type ToolCatalogEntry, type WorkspaceInfo, type WorkspaceNode, type WorkspaceSandboxStatus, type WorkspaceScheduledEvent, type WorkspaceSettings, type WorkspaceTableSummary, type WorkspaceTemplate, type WorkspaceTree } from "@octo/web-ui-corp";
import { setTranslations } from "@mariozechner/mini-lit";
import { html, render } from "lit";
import { icon } from "@mariozechner/mini-lit";
import { AtSign, Box, Brackets, ChevronDown, ChevronRight, Database, Download, Eye, File, FileArchive, FileAudio, FileCode, FileCog, FileImage, FileJson, FilePlay, FileSpreadsheet, FileTerminal, FileText, Folder, FolderCog, FolderOpen, KeyRound, LoaderCircle, LogOut, MessageSquare, Plug, Plus, Presentation, ShieldCheck, SquareTerminal, Table2, Tag, Tags, Trash2 } from "lucide";
import "./app.css";

applyAppTheme();
await configureFioriTheme();

// Register translations in the local mini-lit instance
setTranslations(translations);

// Read config from URL params
const urlParams = new URLSearchParams(window.location.search);
const baseUrl = urlParams.get("baseUrl") || "/api";
const initialRoute = getRouteFromPath();
const authTokenKey = `coreServiceAuthToken:${baseUrl}`;
const providerKey = `coreServiceProvider:${baseUrl}`;
let authToken = localStorage.getItem(authTokenKey);
let currentUser: AuthUser | null = null;
let userName = urlParams.get("userName") || "user";
let authMode: "login" | "register" = "login";
let authError = "";
let ssoConfig: SsoConfig = { enabled: false };
let authResolved = false;
let authDisplayName = "";
let authEmail = "";
let authPassword = "";
let userMenuOpen = false;
let themeMenuOpen = false;
let providerDialogOpen = false;
let createWorkspaceDialogOpen = false;
let workspaceSettingsDialogOpen = false;
let workspaceSettingsTab: "agent" | "connection" | "tools" | "workers" | "sandbox" = "agent";
// Tools tab: the catalog comes from the server, the draft is the unsaved selection.
let toolCatalog: ToolCatalogEntry[] = [];
let toolCatalogLoaded = false;
let toolFilter = "";
let workspaceToolsDraft = new Set<string>();
let workspaceEventsDialogOpen = false;
let selectedProvider = localStorage.getItem(providerKey) || "openai-codex";
let codexConfigured = false;
let codexLoginId = "";
let codexLoginUrl = "";
let codexLoginCode = "";
let codexAuthError = "";
let codexAuthBusy = false;
let serviceFeatures: CoreServiceFeatures = { agentWorkers: true, reminders: true, connection: true, tools: true, llmProviders: null, appTitle: DEFAULT_APP_TITLE, appHeader: DEFAULT_APP_TITLE };
let llmConfig: LlmConfig = { providers: [] };
let llmConfigLoading = false;
let providerKeyInput = "";
let providerKeySaving = false;
let providerKeyError = "";
let providerSavedNotice = "";
let modelFilter = "";
let apiKeysExpanded = false;
let boschModels: CustomModelConfig[] = [];
let boschExpanded: Record<string, boolean> = {};
let boschLoading = false;
let boschSaving = false;
let boschError = "";
// Draft for the "Add model" form (cleared after a successful create).
let boschDraft: { name: string; baseProvider: string; endpoint: string; apiKey: string } = {
	name: "",
	baseProvider: "openai",
	endpoint: "",
	apiKey: "",
};

// App state
let sidebarOpen = true;
let workspaces: WorkspaceInfo[] = [];
let workspaceTemplates: WorkspaceTemplate[] = [];
let workspaceId = initialRoute.workspaceId ?? localStorage.getItem("workspaceId") ?? "";
let channelId = initialRoute.sessionId ?? (workspaceId ? sessionStorage.getItem(`sessionId:${workspaceId}`) || "" : "");
let sessions: SessionInfo[] = [];
let sessionFilter = "";
let artifactFilter = "";
let workspaceOpen = true;
let workspaceTab: "artifacts" | "skills" = "artifacts";
let workspaceTree: WorkspaceTree = { artifacts: [], skills: [] };
let workspaceSettings: WorkspaceSettings = {};
let workspaceSandboxStatus: WorkspaceSandboxStatus | null = null;
let workspaceEvents: WorkspaceScheduledEvent[] = [];
let workspaceAgentPromptDraft = "";
let workspaceSettingsError = "";
let workspaceSettingsBusy = false;
let workspaceEventsBusy = false;
let workspaceEventsError = "";
let acpJobs: AcpJob[] = [];
let acpJobPollTimer: number | undefined;
let agentWorkers: ConnectorStatus[] = [];
let businessConnectors: ConnectorStatus[] = [];
let agentWorkerBusy = "";
let agentWorkerLoginOutput = "";
let businessConnectorBusy = "";
let businessConnectorLoginOutput = "";

let sapDestinations: SapDestination[] = [];
let sapDestinationsLoaded = false;
let sapNewDestination = "";
let sapNewAlias = "";
let sapBusy = "";
let sapError = "";
let sapConnMode: "destination" | "local" = "local";
let sapLocalSystems: SapLocalSystem[] = [];
let sapLocalSystemsLoaded = false;
let sapLocalSelected = ""; // `${systemId}|${client}` key
let sapLocalUrl = "";
let sapLocalSpn = "";
let sapLocalClient = "";
let sapLocalLanguage = "";
const sapTreeManifests = new Map<string, Record<string, SapTreeManifestEntry>>();

const connectorLoginModes = new Map<string, string>();
const LOGIN_INPUT_PROMPT_LIMIT = 3;
const LOGIN_INPUT_PROMPT_PATTERN = /paste|enter|code|verification|continue|\[Y\/n\]/i;
let agentWorkersCollapsed = localStorage.getItem("agentWorkersCollapsed") === "true";
let newWorkspaceName = "New workspace";
let newWorkspaceTemplateId = "sap-cap";
let newWorkspaceBusy = false;
let newWorkspaceError = "";
// Skill folder upload (Skills tab). Files are read in the browser, then confirmed in a
// dialog before anything is sent, so a mis-picked folder never reaches the server.
const MAX_SKILL_UPLOAD_FILES = 500;
const MAX_SKILL_UPLOAD_BYTES = 25 * 1024 * 1024;
const SKILL_UPLOAD_SKIP_NAMES = new Set([".DS_Store", "Thumbs.db"]);
const SKILL_UPLOAD_SKIP_DIRS = new Set([".git", "node_modules"]);
let skillUploadDialogOpen = false;
let skillUploadReading = false;
let skillUploadFolderName = "";
let skillUploadFiles: SkillUploadFile[] = [];
let skillUploadBytes = 0;
let skillUploadSkipped: string[] = [];
let skillUploadBusy = false;
let skillUploadError = "";
const databaseTables = new Map<string, WorkspaceTableSummary[]>();
const expandedFolders = new Set<string>();
const client = new CoreServiceClient(baseUrl, () => authToken);

type McpServerDraft = NonNullable<NonNullable<WorkspaceSettings["mcp"]>["servers"]>[number];
let workspaceMcpServersDraft: McpServerDraft[] = [];

const chatPanel = new CoreServiceChatPanel();
chatPanel.baseUrl = baseUrl;
chatPanel.channelId = channelId;
chatPanel.userName = userName;
chatPanel.agentName = serviceFeatures.appTitle;
chatPanel.authToken = authToken;
chatPanel.addEventListener("file-preview-open", () => {
	if (workspaceOpen && sidebarOpen) {
		sidebarOpen = false;
		renderApp();
	}
});
// Debounced artifacts refresh when the agent creates/edits/deletes files.
let workspaceRefreshTimer: number | undefined;
chatPanel.addEventListener("workspace-changed", () => {
	if (workspaceRefreshTimer !== undefined) clearTimeout(workspaceRefreshTimer);
	workspaceRefreshTimer = window.setTimeout(() => {
		workspaceRefreshTimer = undefined;
		void loadWorkspace();
	}, 1000);
});
// The composer's "+" menu offers "Browser Skills"; the picker, the confirmation
// dialog and the replace prompt already live here, so the chat just asks for them.
chatPanel.addEventListener("skill-upload-request", () => {
	if (!workspaceId) {
		alert("Open a workspace first");
		return;
	}
	document.getElementById("skill-folder-input")?.click();
});

const app = document.getElementById("app");
if (!app) throw new Error("App container not found");

type Ui5ButtonDesign = "Default" | "Emphasized" | "Transparent" | "Positive" | "Negative" | "Attention";
type AppTheme = "light" | "dark" | "joule-light" | "joule-dark";

const THEME_OPTIONS: { value: AppTheme; label: string }[] = [
	{ value: "light", label: "Fiori Light" },
	{ value: "dark", label: "Fiori Dark" },
	{ value: "joule-light", label: "AI Light" },
	{ value: "joule-dark", label: "AI Dark" },
];

function getStoredTheme(): AppTheme {
	const theme = localStorage.getItem("theme");
	if (theme === "dark" || theme === "light" || theme === "joule-light" || theme === "joule-dark") return theme;
	// legacy "system"/null → follow prefers-color-scheme
	return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyAppTheme() {
	const theme = getStoredTheme();
	const isDark = theme === "dark" || theme === "joule-dark";
	const isJoule = theme === "joule-light" || theme === "joule-dark";
	document.documentElement.classList.toggle("dark", isDark);
	document.documentElement.classList.toggle("joule", isJoule);
}

function setAppTheme(theme: AppTheme) {
	localStorage.setItem("theme", theme);
	applyAppTheme();
}

// The service owns the product name (CORE_SERVICE_APP_TITLE), so a deployment can
// rebrand without a frontend build. Called right after getFeatures().
function applyAppTitle() {
	document.title = serviceFeatures.appTitle;
	chatPanel.agentName = serviceFeatures.appTitle;
}

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
	const theme = localStorage.getItem("theme");
	if (!theme || theme === "system") {
		applyAppTheme();
		renderApp();
	}
});

function Ui5Button(config: {
	children?: unknown;
	className?: string;
	design?: Ui5ButtonDesign;
	disabled?: boolean;
	ui5Icon?: string;
	onClick?: (event: Event) => void;
	title?: string;
}) {
	return html`
		<ui5-button
			class=${`corp-ui5-button ${config.className ?? ""}`}
			design=${config.design ?? "Transparent"}
			icon=${config.ui5Icon ?? ""}
			title=${config.title ?? ""}
			?disabled=${config.disabled ?? false}
			@click=${config.onClick}
		>
			${config.children ?? ""}
		</ui5-button>
	`;
}

function renderThemeMenu() {
	const current = getStoredTheme();
	return html`
		<div class="relative">
			${Ui5Button({
				className: "corp-icon-button",
				ui5Icon: "palette",
				onClick: () => { themeMenuOpen = !themeMenuOpen; userMenuOpen = false; renderApp(); },
				title: "Theme",
			})}
			${themeMenuOpen
				? html`
					<div class="absolute right-0 top-10 z-50 w-48 rounded border border-border bg-background shadow-lg">
						${THEME_OPTIONS.map((opt) => html`
							<ui5-button
								class="corp-ui5-button corp-menu-button ${opt.value === current ? "corp-menu-button-active" : ""}"
								design="Transparent"
								@click=${() => { setAppTheme(opt.value); themeMenuOpen = false; renderApp(); }}
							>
								<span>${opt.label}</span>
							</ui5-button>
						`)}
					</div>`
				: ""}
		</div>
	`;
}

function getUi5Value(event: Event) {
	return String((event.target as HTMLInputElement & { value?: string }).value ?? "");
}

function getUi5SelectValue(event: Event, fallback: string) {
	const target = event.target as HTMLElement & { selectedOption?: { value?: string }; value?: string };
	return String(target.selectedOption?.value ?? target.value ?? fallback);
}

function getRouteFromPath() {
	const workspaceSessionMatch = window.location.pathname.match(/\/(?:w|workspaces?)\/([^/]+)\/(?:s|sessions?)\/([^/]+)/);
	if (workspaceSessionMatch) {
		return {
			workspaceId: decodeURIComponent(workspaceSessionMatch[1]),
			sessionId: decodeURIComponent(workspaceSessionMatch[2]),
		};
	}
	const sessionMatch = window.location.pathname.match(/\/sessions?\/([^/]+)/);
	return {
		workspaceId: undefined,
		sessionId: sessionMatch ? decodeURIComponent(sessionMatch[1]) : undefined,
	};
}

function syncSessionUrl(id: string, replace = false, targetWorkspaceId = workspaceId) {
	if (!id || !targetWorkspaceId) return;
	const nextUrl = `/w/${encodeURIComponent(targetWorkspaceId)}/s/${encodeURIComponent(id)}${window.location.search}`;
	if (`${window.location.pathname}${window.location.search}` === nextUrl) return;
	const state = { workspaceId: targetWorkspaceId, sessionId: id };
	if (replace) window.history.replaceState(state, "", nextUrl);
	else window.history.pushState(state, "", nextUrl);
}

window.addEventListener("popstate", () => {
	const route = getRouteFromPath();
	if (route.workspaceId && route.workspaceId !== workspaceId && workspaces.some((w) => w.id === route.workspaceId)) {
		void switchWorkspace(route.workspaceId);
		return;
	}
	if (route.sessionId && route.sessionId !== channelId && sessions.some((s) => s.channelId === route.sessionId)) {
		channelId = route.sessionId;
		if (workspaceId) sessionStorage.setItem(`sessionId:${workspaceId}`, route.sessionId);
		chatPanel.channelId = route.sessionId;
		void loadWorkspace();
		renderApp();
	}
});

async function loadWorkspaces() {
	workspaceTemplates = await client.getWorkspaceTemplates();
	workspaces = await client.getWorkspaces();
	if (workspaces.length === 0) {
		const created = await client.createWorkspace("Default workspace", { templateId: "sap-cap" });
		if (created) workspaces = [created];
	}
	const route = getRouteFromPath();
	if (route.workspaceId && workspaces.some((w) => w.id === route.workspaceId)) {
		workspaceId = route.workspaceId;
		localStorage.setItem("workspaceId", workspaceId);
		if (route.sessionId) {
			channelId = route.sessionId;
			chatPanel.channelId = channelId;
			sessionStorage.setItem(`sessionId:${workspaceId}`, channelId);
		}
	} else if (!workspaceId || !workspaces.some((w) => w.id === workspaceId)) {
		workspaceId = workspaces[0]?.id || "";
		if (workspaceId) localStorage.setItem("workspaceId", workspaceId);
	}
	await loadSessions();
	startAcpJobPolling();
}

async function loadSessions() {
	if (!workspaceId) {
		sessions = [];
		channelId = "";
		chatPanel.channelId = "";
		renderApp();
		return;
	}
	const route = getRouteFromPath();
	const routedSessionId = route.workspaceId === workspaceId ? route.sessionId : undefined;
	sessions = await client.getSessions(workspaceId);
	if (sessions.length === 0) {
		const created = await client.createSession(workspaceId, "New session");
		if (created) sessions = await client.getSessions(workspaceId);
	}
	const savedSessionId = sessionStorage.getItem(`sessionId:${workspaceId}`) || "";
	const nextSessionId =
		(routedSessionId && sessions.some((s) => s.channelId === routedSessionId) ? routedSessionId : "") ||
		(channelId && sessions.some((s) => s.channelId === channelId) ? channelId : "") ||
		(savedSessionId && sessions.some((s) => s.channelId === savedSessionId) ? savedSessionId : "") ||
		sessions[0]?.channelId ||
		"";
	if (nextSessionId !== channelId) {
		channelId = nextSessionId;
		chatPanel.channelId = channelId;
	}
	if (channelId) sessionStorage.setItem(`sessionId:${workspaceId}`, channelId);
	if (channelId) syncSessionUrl(channelId, true);
	await loadWorkspace();
	renderApp();
}

async function loadWorkspace() {
	if (!channelId) return;
	workspaceTree = (await client.getWorkspace(channelId!)) ?? { artifacts: [], skills: [] };
	await loadSapManifests();
	await refreshAcpJobs(false);
	renderApp();
}

async function deleteWorkspaceEntry(path: string, isFolder = false) {
	const name = path.split("/").pop() ?? path;
	const message = isFolder
		? `Delete folder "${name}" and all its contents? This cannot be undone.`
		: `Delete "${name}"? This cannot be undone.`;
	if (!confirm(message)) return;
	const result = await client.deleteWorkspaceFile(path);
	if (!result.ok) alert(`Delete failed: ${result.error ?? "unknown error"}`);
	await loadWorkspace();
}

async function downloadWorkspaceEntry(path: string, isFolder = false) {
	// Folders are downloaded as a .zip archive built by the server.
	const zipName = isFolder ? `${path.split("/").pop() ?? "folder"}.zip` : undefined;
	const ok = await client.downloadWorkspaceFile(path, zipName);
	if (!ok) alert("Download failed");
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// A folder picker hands over every file it found, each carrying its path relative to the
// picked folder in webkitRelativePath. Read them all, then let the user confirm.
async function onSkillFolderPicked(event: Event) {
	const input = event.target as HTMLInputElement;
	const picked = Array.from(input.files ?? []);
	input.value = ""; // Reset so picking the same folder again still fires a change event.
	if (picked.length === 0) return;

	const relPathOf = (file: File) => (file.webkitRelativePath || file.name).replace(/\\/g, "/");
	skillUploadFolderName = relPathOf(picked[0]).split("/")[0] || picked[0].name;
	skillUploadSkipped = [];
	skillUploadFiles = [];
	skillUploadBytes = 0;
	skillUploadError = "";
	skillUploadBusy = false;

	const wanted: Array<{ file: File; path: string }> = [];
	for (const file of picked) {
		const segments = relPathOf(file).split("/");
		if (segments.length > 1) segments.shift(); // Drop the picked folder itself.
		const rel = segments.join("/");
		if (SKILL_UPLOAD_SKIP_NAMES.has(segments[segments.length - 1]) || segments.some((seg) => SKILL_UPLOAD_SKIP_DIRS.has(seg))) {
			skillUploadSkipped.push(rel);
			continue;
		}
		wanted.push({ file, path: rel });
		skillUploadBytes += file.size;
	}

	skillUploadDialogOpen = true;
	if (wanted.length === 0) {
		skillUploadError = "That folder has no files to upload";
		renderApp();
		return;
	}
	if (wanted.length > MAX_SKILL_UPLOAD_FILES) {
		skillUploadError = `That folder has ${wanted.length} files; the limit is ${MAX_SKILL_UPLOAD_FILES}`;
		renderApp();
		return;
	}
	if (skillUploadBytes > MAX_SKILL_UPLOAD_BYTES) {
		skillUploadError = `That folder is ${formatBytes(skillUploadBytes)}; the limit is ${formatBytes(MAX_SKILL_UPLOAD_BYTES)}`;
		renderApp();
		return;
	}

	skillUploadReading = true;
	renderApp();
	try {
		skillUploadFiles = await Promise.all(wanted.map(async (entry) => ({ path: entry.path, content: await fileToBase64(entry.file) })));
	} catch (err) {
		skillUploadError = `Could not read the folder: ${err instanceof Error ? err.message : String(err)}`;
	} finally {
		skillUploadReading = false;
		renderApp();
	}
}

function closeSkillUploadDialog() {
	if (skillUploadBusy || skillUploadReading) return;
	skillUploadDialogOpen = false;
	skillUploadFiles = [];
	skillUploadSkipped = [];
	skillUploadError = "";
	renderApp();
}

async function submitSkillUpload(event?: Event) {
	event?.preventDefault();
	if (skillUploadBusy || skillUploadReading || skillUploadFiles.length === 0 || !workspaceId) return;
	skillUploadBusy = true;
	skillUploadError = "";
	renderApp();

	let result = await client.uploadWorkspaceSkill(workspaceId, skillUploadFolderName, skillUploadFiles);
	if (!result.ok && result.exists) {
		const name = result.skillName ?? skillUploadFolderName;
		if (!confirm(`Skill "${name}" already exists. Replace it entirely? Files not in the new folder will be deleted.`)) {
			skillUploadBusy = false;
			renderApp();
			return;
		}
		result = await client.uploadWorkspaceSkill(workspaceId, skillUploadFolderName, skillUploadFiles, true);
	}
	if (!result.ok) {
		skillUploadBusy = false;
		skillUploadError = result.error ?? "Upload failed";
		renderApp();
		return;
	}

	skillUploadBusy = false;
	skillUploadDialogOpen = false;
	skillUploadFiles = [];
	skillUploadSkipped = [];
	workspaceTab = "skills";
	if (result.path) expandedFolders.add(result.path);
	await loadWorkspace();
	// So the composer's Skills menu lists the new skill without a reload.
	await chatPanel.refreshWorkspaceContext();
}

function normalizeWorkspaceArtifactFilename(path: string): string {
	const prefix = `workspaces/${workspaceId}/artifacts/`;
	return path.startsWith(prefix) ? path.slice(prefix.length) : path.split("/").pop() || path;
}

async function deleteSession(id: string) {
	const session = sessions.find((s) => s.channelId === id);
	const label = session?.preview || "this session";
	if (!confirm(`Delete session "${label}"? This permanently removes its messages and attachments. This cannot be undone.`)) return;
	const result = await client.deleteSession(id);
	if (!result.ok) {
		alert(`Delete failed: ${result.error ?? "unknown error"}`);
		return;
	}
	if (id === channelId) {
		channelId = "";
		chatPanel.channelId = "";
		if (workspaceId) sessionStorage.removeItem(`sessionId:${workspaceId}`);
	}
	// loadSessions picks the most recent remaining session or auto-creates a new one.
	await loadSessions();
}

function switchSession(id: string) {
	channelId = id;
	if (workspaceId) sessionStorage.setItem(`sessionId:${workspaceId}`, id);
	chatPanel.channelId = id;
	syncSessionUrl(id);
	acpJobs = [];
	void loadWorkspace();
	renderApp();
}

async function switchWorkspace(id: string) {
	if (id === workspaceId) return;
	workspaceId = id;
	localStorage.setItem("workspaceId", id);
	channelId = sessionStorage.getItem(`sessionId:${workspaceId}`) || "";
	chatPanel.channelId = channelId;
	if (channelId) syncSessionUrl(channelId);
	workspaceTree = { artifacts: [], skills: [] };
	acpJobs = [];
	databaseTables.clear();
	expandedFolders.clear();
	sessionFilter = "";
	artifactFilter = "";
	await loadSessions();
}

async function newWorkspace() {
	if (workspaceTemplates.length === 0) {
		workspaceTemplates = await client.getWorkspaceTemplates();
	}
	newWorkspaceName = "New workspace";
	newWorkspaceTemplateId = workspaceTemplates[0]?.id ?? "sap-cap";
	newWorkspaceError = "";
	newWorkspaceBusy = false;
	createWorkspaceDialogOpen = true;
	renderApp();
}

function closeCreateWorkspaceDialog() {
	if (newWorkspaceBusy) return;
	createWorkspaceDialogOpen = false;
	renderApp();
}

async function submitCreateWorkspace(event?: Event) {
	event?.preventDefault();
	if (newWorkspaceBusy) return;
	const name = newWorkspaceName.trim();
	if (!name) {
		newWorkspaceError = "Workspace name is required";
		renderApp();
		return;
	}
	newWorkspaceBusy = true;
	newWorkspaceError = "";
	renderApp();
	const workspace = await client.createWorkspace(name, { templateId: newWorkspaceTemplateId });
	if (!workspace) {
		newWorkspaceBusy = false;
		newWorkspaceError = "Could not create workspace";
		renderApp();
		return;
	}
	createWorkspaceDialogOpen = false;
	newWorkspaceBusy = false;
	workspaces = await client.getWorkspaces();
	await switchWorkspace(workspace.id);
}

async function newSession() {
	if (!workspaceId) return;
	const session = await client.createSession(workspaceId, "New session");
	if (!session) return;
	await loadSessions();
	switchSession(session.id);
}

function toggleSidebar() {
	sidebarOpen = !sidebarOpen;
	renderApp();
}

function consumeSsoHash() {
	if (!window.location.hash) return;
	const params = new URLSearchParams(window.location.hash.slice(1));
	const token = params.get("sso_token");
	const error = params.get("sso_error");
	if (token) {
		authToken = token;
		localStorage.setItem(authTokenKey, token);
	}
	if (error) authError = error;
	if (token || error) {
		window.history.replaceState(null, "", window.location.pathname + window.location.search);
	}
}

async function refreshSsoConfig() {
	ssoConfig = await client.getSsoConfig();
	if (!currentUser) renderApp();
}

async function initializeAuth() {
	const user = await client.me();
	if (!user) {
		currentUser = null;
		authResolved = true;
		renderApp();
		return;
	}
	authResolved = true;
	currentUser = user;
	userName = user.displayName;
	chatPanel.userName = userName;
	chatPanel.authToken = authToken;
	serviceFeatures = await client.getFeatures();
	applyAppTitle();
	await loadWorkspaces();
}

async function submitAuth(event: Event) {
	event.preventDefault();
	authError = "";
	renderApp();
	try {
		const result = authMode === "register"
			? await client.register(authEmail, authPassword, authDisplayName)
			: await client.login(authEmail, authPassword);
		authToken = result.token;
		localStorage.setItem(authTokenKey, authToken);
		currentUser = result.user;
		userName = result.user.displayName;
		chatPanel.userName = userName;
		chatPanel.authToken = authToken;
		serviceFeatures = await client.getFeatures();
		applyAppTitle();
		await loadWorkspaces();
	} catch (err) {
		authError = err instanceof Error ? err.message : String(err);
		renderApp();
	}
}

async function logout() {
	await client.logout();
	stopAcpJobPolling();
	authToken = null;
	localStorage.removeItem(authTokenKey);
	authDisplayName = "";
	authEmail = "";
	authPassword = "";
	currentUser = null;
	userMenuOpen = false;
	themeMenuOpen = false;
	providerDialogOpen = false;
	workspaces = [];
	sessions = [];
	workspaceId = "";
	channelId = "";
	chatPanel.channelId = "";
	chatPanel.authToken = null;
	renderApp();
}

async function refreshAcpJobs(shouldRender = true) {
	if (!serviceFeatures.agentWorkers) {
		acpJobs = [];
		if (shouldRender) renderApp();
		return;
	}
	if (!channelId) {
		acpJobs = [];
		if (shouldRender) renderApp();
		return;
	}
	acpJobs = await client.getAcpJobs(channelId);
	if (shouldRender) renderApp();
}

async function refreshAgentWorkers(shouldRender = true) {
	if (!serviceFeatures.agentWorkers) {
		agentWorkers = [];
		if (shouldRender) renderApp();
		return;
	}
	agentWorkers = await client.getConnectors("agent-runtime");
	if (shouldRender) renderApp();
}

async function refreshWorkspaceSandbox(shouldRender = true) {
	workspaceSandboxStatus = workspaceId ? await client.getWorkspaceSandbox(workspaceId) : null;
	if (shouldRender) renderApp();
}

async function refreshWorkspaceEvents(shouldRender = true) {
	if (!serviceFeatures.reminders) {
		workspaceEvents = [];
		if (shouldRender) renderApp();
		return;
	}
	if (!workspaceId) {
		workspaceEvents = [];
		if (shouldRender) renderApp();
		return;
	}
	workspaceEventsBusy = true;
	workspaceEventsError = "";
	if (shouldRender) renderApp();
	workspaceEvents = await client.getWorkspaceEvents(workspaceId);
	workspaceEventsBusy = false;
	if (shouldRender) renderApp();
}

async function openWorkspaceEventsDialog() {
	if (!serviceFeatures.reminders) return;
	workspaceEventsDialogOpen = true;
	await refreshWorkspaceEvents(false);
	renderApp();
}

function closeWorkspaceEventsDialog() {
	workspaceEventsDialogOpen = false;
	workspaceEventsError = "";
	renderApp();
}

async function deleteWorkspaceEvent(filename: string) {
	if (!serviceFeatures.reminders) return;
	if (!workspaceId) return;
	workspaceEventsBusy = true;
	workspaceEventsError = "";
	renderApp();
	const ok = await client.deleteWorkspaceEvent(workspaceId, filename);
	if (!ok) {
		workspaceEventsBusy = false;
		workspaceEventsError = "Could not cancel scheduled event";
		renderApp();
		return;
	}
	await refreshWorkspaceEvents(false);
	renderApp();
}

async function refreshBusinessConnectors(shouldRender = true) {
	businessConnectors = await client.getConnectors("business-connector");
	if (shouldRender) renderApp();
}

function startAcpJobPolling() {
	stopAcpJobPolling();
	acpJobPollTimer = window.setInterval(() => {
		if (serviceFeatures.agentWorkers) {
			void refreshAcpJobs();
			void refreshAgentWorkers();
		}
		void refreshBusinessConnectors();
	}, 2000);
	if (serviceFeatures.agentWorkers) {
		void refreshAcpJobs();
		void refreshAgentWorkers();
	}
	void refreshBusinessConnectors();
}

function stopAcpJobPolling() {
	if (acpJobPollTimer !== undefined) {
		window.clearInterval(acpJobPollTimer);
		acpJobPollTimer = undefined;
	}
}

async function cancelAcpJob(jobId: string) {
	if (!serviceFeatures.agentWorkers) return;
	if (!channelId) return;
	await client.cancelAcpJob(channelId, jobId);
	await refreshAcpJobs();
}

async function connectAgentWorker(agent: string) {
	if (!serviceFeatures.agentWorkers) return;
	agentWorkerBusy = agent;
	agentWorkerLoginOutput = "";
	renderApp();
	try {
		const login = await client.startConnectorLogin(agent, {
			loginMode: connectorLoginModes.get(agent),
		});
		if (!login) throw new Error("Could not start worker login");
		
		const openedUrls = new Set<string>();
		if (login.url) {
			openedUrls.add(login.url);
			window.open(login.url, "_blank", "noopener,noreferrer");
		}
		
		const deadline = Date.now() + 180000;
		let lastOutput = login.output ?? "";
		let inputPromptCount = 0;
		
		while (Date.now() < deadline) {
			const status = await client.getConnectorLoginStatus(agent, login.loginId);
			if (!status) break;
			lastOutput = status.output ?? lastOutput;
			agentWorkerLoginOutput = lastOutput;
			const url = status.url;
			if (url && !openedUrls.has(url)) {
				openedUrls.add(url);
				window.open(url, "_blank", "noopener,noreferrer");
			}
			renderApp();
			if (status.status === "complete") break;
			if (status.status === "error") throw new Error(status.error || "Worker login failed");
			if (LOGIN_INPUT_PROMPT_PATTERN.test(lastOutput)) {
				inputPromptCount += 1;
				if (inputPromptCount > LOGIN_INPUT_PROMPT_LIMIT) {
					throw new Error("Worker login failed after 3 input attempts");
				}

				const input = prompt(`${login.label} login input:`);
				if (!input) throw new Error("Worker login cancelled");

				await client.sendConnectorLoginInput(agent, login.loginId, input);
			}
			await new Promise((resolve) => setTimeout(resolve, 1500));
		}
	} catch (err) {
		agentWorkerLoginOutput = err instanceof Error ? err.message : String(err);
	} finally {
		agentWorkerBusy = "";
		await refreshAgentWorkers(false);
		renderApp();
	}
}

async function disconnectAgentWorker(agent: string) {
	if (!serviceFeatures.agentWorkers) return;
	agentWorkerBusy = agent;
	renderApp();
	try {
		await client.logoutConnector(agent);
		await refreshAgentWorkers(false);
	} finally {
		agentWorkerBusy = "";
		renderApp();
	}
}

async function connectBusinessConnector(connectorId: string) {
	businessConnectorBusy = connectorId;
	businessConnectorLoginOutput = "";
	renderApp();
	try {
		const login = await client.startConnectorLogin(connectorId, {
			loginMode: connectorLoginModes.get(connectorId),
		});
		if (!login) throw new Error("Could not start connector login");
		
		const openedUrls = new Set<string>();
		if (login.url) {
			openedUrls.add(login.url);
			window.open(login.url, "_blank", "noopener,noreferrer");
		}
		
		const deadline = Date.now() + 180000;
		let lastOutput = login.output ?? "";
		let inputPromptCount = 0;
		
		while (Date.now() < deadline) {
			const status = await client.getConnectorLoginStatus(connectorId, login.loginId);
			if (!status) break;
			lastOutput = status.output ?? lastOutput;
			businessConnectorLoginOutput = lastOutput;
			const url = status.url;
			if (url && !openedUrls.has(url)) {
				openedUrls.add(url);
				window.open(url, "_blank", "noopener,noreferrer");
			}
			renderApp();
			if (status.status === "complete") break;
			if (status.status === "error") throw new Error(status.error || "Connector login failed");
			if (LOGIN_INPUT_PROMPT_PATTERN.test(lastOutput)) {
				inputPromptCount += 1;
				if (inputPromptCount > LOGIN_INPUT_PROMPT_LIMIT) {
					throw new Error("Connector login failed after 3 input attempts");
				}

				const input = prompt(`${login.label} login input:`);
				if (!input) throw new Error("Connector login cancelled");

				await client.sendConnectorLoginInput(connectorId, login.loginId, input);
			}
			await new Promise((resolve) => setTimeout(resolve, 1500));
		}
	} catch (err) {
		businessConnectorLoginOutput = err instanceof Error ? err.message : String(err);
	} finally {
		businessConnectorBusy = "";
		await refreshBusinessConnectors(false);
		renderApp();
	}
}

async function disconnectBusinessConnector(connectorId: string) {
	businessConnectorBusy = connectorId;
	renderApp();
	try {
		await client.logoutConnector(connectorId);
		await refreshBusinessConnectors(false);
	} finally {
		businessConnectorBusy = "";
		renderApp();
	}
}

async function loadSapManifests() {
	if (!workspaceId) return;
	const conns = workspaceSettings.sapConnections ?? [];
	await Promise.all(
		conns.map(async (c) => {
			sapTreeManifests.set(c.name, await client.getSapTreeManifest(workspaceId!, c.name));
		}),
	);
}

function sapTreeLookup(path: string): { conn: string; relKey: string; info: SapTreeManifestEntry } | null {
	const marker = "/artifacts/";
	const idx = path.indexOf(marker);
	if (idx < 0) return null;
	const rest = path.slice(idx + marker.length); // <conn>/<relKey...>
	const slash = rest.indexOf("/");
	const conn = slash < 0 ? rest : rest.slice(0, slash);
	const relKey = slash < 0 ? "" : rest.slice(slash + 1);
	const manifest = sapTreeManifests.get(conn);
	if (!manifest) return null;
	const info = manifest[relKey];
	return info ? { conn, relKey, info } : null;
}

async function loadSapDestinations() {
	if (!workspaceId) return;
	sapBusy = "destinations";
	sapError = "";
	renderApp();
	try {
		sapDestinations = await client.listSapDestinations(workspaceId);
		sapDestinationsLoaded = true;
		if (!sapNewDestination && sapDestinations.length > 0) {
			sapNewDestination = sapDestinations[0]!.name;
		}
	} finally {
		sapBusy = "";
		renderApp();
	}
}

async function createSapConnection() {
	const destination = sapNewDestination.trim();
	if (!workspaceId || !destination) return;
	const alias = (sapNewAlias || destination).trim();
	sapBusy = "create";
	sapError = "";
	renderApp();
	try {
		const { connection, error } = await client.createSapConnection(workspaceId, { destination, name: alias });
		if (error) sapError = error;
		if (connection) {
			sapNewAlias = "";
			workspaceSettings = await client.getWorkspaceSettings(workspaceId);
			workspaceOpen = true;
			await loadWorkspace();
			closeWorkspaceSettingsDialog();
		}
	} finally {
		sapBusy = "";
		renderApp();
	}
}

async function loadLocalSystems() {
	if (!workspaceId) return;
	sapBusy = "local-systems";
	sapError = "";
	renderApp();
	try {
		sapLocalSystems = await client.listLocalSapSystems(workspaceId);
		sapLocalSystemsLoaded = true;
		if (!sapLocalSelected && sapLocalSystems.length > 0) selectLocalSystem(sapLocalSystems[0]!);
	} finally {
		sapBusy = "";
		renderApp();
	}
}

function selectLocalSystem(sys: SapLocalSystem) {
	sapLocalSelected = `${sys.systemId}|${sys.client ?? ""}`;
	sapLocalUrl = sys.adtUrl;
	sapLocalSpn = sys.spn;
	sapLocalClient = sys.client ?? "";
	sapLocalLanguage = sapLocalLanguage || "EN";
	if (!sapNewAlias) sapNewAlias = sys.client ? `${sys.systemId}_${sys.client}` : sys.systemId;
}

async function createLocalConnection() {
	const url = sapLocalUrl.trim();
	const spn = sapLocalSpn.trim();
	if (!workspaceId || !url || !spn) return;
	const selected = sapLocalSystems.find((s) => `${s.systemId}|${s.client ?? ""}` === sapLocalSelected);
	const alias = (sapNewAlias || selected?.systemId || url).trim();
	sapBusy = "create";
	sapError = "";
	renderApp();
	try {
		const { connection, error } = await client.createLocalSapConnection(workspaceId, {
			url,
			spn,
			systemId: selected?.systemId,
			name: alias,
			client: sapLocalClient.trim() || undefined,
			language: sapLocalLanguage.trim() || undefined,
		});
		if (error) sapError = error;
		if (connection) {
			sapNewAlias = "";
			workspaceSettings = await client.getWorkspaceSettings(workspaceId);
			workspaceOpen = true;
			await loadWorkspace();
			closeWorkspaceSettingsDialog();
		}
	} finally {
		sapBusy = "";
		renderApp();
	}
}

function openProviderDialog() {
	userMenuOpen = false;
	themeMenuOpen = false;
	providerDialogOpen = true;
	codexAuthError = "";
	codexLoginCode = "";
	providerKeyInput = "";
	providerKeyError = "";
	providerSavedNotice = "";
	modelFilter = "";
	void refreshCodexStatus();
	void loadLlmConfig();
	void loadBoschModels();
	renderApp();
}

function closeProviderDialog() {
	providerDialogOpen = false;
	renderApp();
}

async function openWorkspaceSettingsDialog() {
	if (!workspaceId) return;
	workspaceSettingsDialogOpen = true;
	workspaceSettingsTab = "agent";
	workspaceSettingsError = "";
	workspaceSettingsBusy = true;
	renderApp();
	const [settings, catalog] = await Promise.all([
		client.getWorkspaceSettings(workspaceId),
		loadToolCatalog(),
		refreshBusinessConnectors(false),
		serviceFeatures.agentWorkers ? refreshAgentWorkers(false) : Promise.resolve(),
		refreshWorkspaceSandbox(false),
	]);
	workspaceSettings = settings;
	workspaceAgentPromptDraft = workspaceSettings.agent?.prompt ?? "";
	workspaceMcpServersDraft = cloneMcpServers(workspaceSettings);
	workspaceToolsDraft = resolveEnabledTools(workspaceSettings.tools?.enabled, catalog);
	toolFilter = "";
	workspaceSettingsBusy = false;
	renderApp();
}

async function loadToolCatalog(): Promise<ToolCatalogEntry[]> {
	if (!serviceFeatures.tools) return [];
	if (toolCatalogLoaded) return toolCatalog;
	toolCatalog = await client.getToolCatalog();
	toolCatalogLoaded = toolCatalog.length > 0;
	// A draft seeded against an empty catalog resolves to nothing, which would
	// silently disable every tool on save. Re-seed once the real catalog lands.
	if (toolCatalogLoaded) {
		workspaceToolsDraft = resolveEnabledTools(workspaceSettings.tools?.enabled, toolCatalog);
	}
	return toolCatalog;
}

/**
 * Mirrors resolveEnabledTools in core-agent: an unset list, or one holding a
 * name the catalog does not know, means the workspace predates the Tools tab
 * and falls back to the defaults. An empty list is honored as "all off".
 */
function resolveEnabledTools(configured: string[] | undefined, catalog: ToolCatalogEntry[]): Set<string> {
	const defaults = () => new Set(catalog.filter((tool) => tool.defaultEnabled).map((tool) => tool.name));
	if (!configured || catalog.length === 0) return defaults();
	const known = new Set(catalog.map((tool) => tool.name));
	if (configured.some((name) => !known.has(name))) return defaults();
	return new Set(configured);
}

async function openAgentWorkerSettingsDialog() {
	if (!serviceFeatures.agentWorkers) return;
	if (!workspaceId) return;
	workspaceSettingsDialogOpen = true;
	workspaceSettingsTab = "workers";
	workspaceSettingsError = "";
	workspaceSettingsBusy = true;
	renderApp();
	const [settings, catalog] = await Promise.all([
		client.getWorkspaceSettings(workspaceId),
		loadToolCatalog(),
		refreshAgentWorkers(false),
		refreshWorkspaceSandbox(false),
	]);
	workspaceSettings = settings;
	workspaceAgentPromptDraft = workspaceSettings.agent?.prompt ?? "";
	workspaceMcpServersDraft = cloneMcpServers(workspaceSettings);
	workspaceToolsDraft = resolveEnabledTools(workspaceSettings.tools?.enabled, catalog);
	toolFilter = "";
	workspaceSettingsBusy = false;
	renderApp();
}

function cloneMcpServers(settings: WorkspaceSettings): McpServerDraft[] {
	return (settings.mcp?.servers ?? []).map((server) => ({
		...server,
		enabled: server.enabled !== false,
		transport: server.transport ?? (server.url ? "streamable-http" : "stdio"),
		args: [...(server.args ?? [])],
		allowedTools: [...(server.allowedTools ?? [])],
		blockedTools: [...(server.blockedTools ?? [])],
		env: server.env ? { ...server.env } : undefined,
		headers: server.headers ? { ...server.headers } : undefined,
	}));
}

function normalizeMcpServers(servers: McpServerDraft[]): McpServerDraft[] {
	return servers
		.map((server) => ({
			...server,
			name: server.name.trim(),
			command: server.command?.trim() || undefined,
			url: server.url?.trim() || undefined,
			toolPrefix: server.toolPrefix?.trim() || undefined,
			args: server.args?.filter(Boolean),
			allowedTools: server.allowedTools?.filter(Boolean),
			blockedTools: server.blockedTools?.filter(Boolean),
			timeoutMs: server.timeoutMs && server.timeoutMs > 0 ? server.timeoutMs : undefined,
		}))
		.filter((server) => server.name && (server.transport === "stdio" ? server.command : server.url));
}

function addMcpServer() {
	workspaceMcpServersDraft = [
		...workspaceMcpServersDraft,
		{ name: "agentic_news", enabled: true, transport: "streamable-http", url: "https://api.agentic-news.ai/mcp", toolPrefix: "news", timeoutMs: 30000 },
	];
	renderApp();
}

function updateMcpServer(index: number, patch: Partial<McpServerDraft>) {
	workspaceMcpServersDraft = workspaceMcpServersDraft.map((server, i) => i === index ? { ...server, ...patch } : server);
	renderApp();
}

function removeMcpServer(index: number) {
	workspaceMcpServersDraft = workspaceMcpServersDraft.filter((_, i) => i !== index);
	renderApp();
}

function parseCsvList(value: string): string[] {
	return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseJsonObject(value: string): Record<string, string> | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const parsed = JSON.parse(trimmed) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object.");
	return parsed as Record<string, string>;
}

function closeWorkspaceSettingsDialog() {
	workspaceSettingsDialogOpen = false;
	workspaceSettingsError = "";
	renderApp();
}

async function saveWorkspaceSettings(event: Event) {
	event.preventDefault();
	if (!workspaceId) return;
	const form = ((event.currentTarget as HTMLElement).closest?.("form") ?? event.currentTarget) as HTMLFormElement;
	const data = new FormData(form);

	workspaceSettingsBusy = true;
	workspaceSettingsError = "";
	renderApp();
	const next: WorkspaceSettings = {
		agent: {
			prompt: workspaceAgentPromptDraft,
			promptFile: workspaceSettings.agent?.promptFile,
		},
		sapConnection: workspaceSettingsTab === "connection"
			? {
				enabled: true,
				systemUrl: String(data.get("sapSystemUrl") || ""),
				client: String(data.get("sapClient") || ""),
				username: String(data.get("sapUsername") || ""),
				authType: String(data.get("sapAuthType") || "basic") as "basic" | "destination" | "oauth",
				destinationName: String(data.get("sapDestinationName") || ""),
			}
			: workspaceSettings.sapConnection,
		// Never write the draft when the catalog is missing — it would resolve to
		// an empty list and read back as "the user turned everything off".
		tools: workspaceSettingsTab === "tools" && toolCatalogLoaded ? { enabled: [...workspaceToolsDraft] } : workspaceSettings.tools,
		connectors: workspaceSettingsTab === "connection"
			? {
				allowed: data.getAll("allowedConnectors").map(String),
			}
			: workspaceSettings.connectors,
		mcp: workspaceSettingsTab === "connection" ? { servers: normalizeMcpServers(workspaceMcpServersDraft) } : workspaceSettings.mcp,
	};
	const saved = await client.updateWorkspaceSettings(workspaceId, next);
	workspaceSettingsBusy = false;
	if (!saved) {
		workspaceSettingsError = "Could not save workspace settings";
		renderApp();
		return;
	}
	workspaceSettings = saved;
	workspaceSettingsDialogOpen = false;
	renderApp();
}

function setProvider(provider: string) {
	selectedProvider = provider;
	localStorage.setItem(providerKey, provider);
	codexAuthError = "";
	providerKeyInput = "";
	providerKeyError = "";
	providerSavedNotice = "";
	modelFilter = "";
	apiKeysExpanded = !llmConfig.providers.find((p) => p.id === provider)?.hasKey;
	if (provider === "openai-codex") void refreshCodexStatus();
	renderApp();
}

async function refreshCodexStatus() {
	const status = await client.getCodexAuthStatus();
	codexConfigured = status?.configured === true;
	renderApp();
}

const LLM_KEY_PROVIDERS = new Set(["openai", "anthropic", "google"]);

async function loadLlmConfig() {
	llmConfigLoading = true;
	providerKeyError = "";
	renderApp();
	llmConfig = await client.getLlmConfig();
	llmConfigLoading = false;
	apiKeysExpanded = !currentProviderConfig()?.hasKey;
	renderApp();
}

function currentProviderConfig() {
	return llmConfig.providers.find((p) => p.id === selectedProvider);
}

async function loadBoschModels() {
	boschLoading = true;
	boschError = "";
	renderApp();
	try {
		boschModels = await client.getCustomModels();
	} catch (err) {
		boschError = err instanceof Error ? err.message : String(err);
	} finally {
		boschLoading = false;
		renderApp();
	}
}

async function addBoschModel() {
	const name = boschDraft.name.trim();
	const endpoint = boschDraft.endpoint.trim();
	const apiKey = boschDraft.apiKey.trim();
	if (!name || !endpoint || !apiKey) {
		boschError = "Name, endpoint and API key are required.";
		renderApp();
		return;
	}
	boschSaving = true;
	boschError = "";
	renderApp();
	try {
		await client.addCustomModel({ name, baseProvider: boschDraft.baseProvider, endpoint, apiKey });
		boschDraft = { name: "", baseProvider: "openai", endpoint: "", apiKey: "" };
		await loadBoschModels();
		void chatPanel.refreshActiveModels();
	} catch (err) {
		boschError = err instanceof Error ? err.message : String(err);
	} finally {
		boschSaving = false;
		renderApp();
	}
}

async function updateBoschModel(model: CustomModelConfig, patch: Partial<Pick<CustomModelConfig, "name" | "baseProvider" | "endpoint">> & { apiKey?: string }) {
	boschSaving = true;
	boschError = "";
	renderApp();
	try {
		await client.updateCustomModel(model.id, {
			name: patch.name ?? model.name,
			baseProvider: patch.baseProvider ?? model.baseProvider,
			endpoint: patch.endpoint ?? model.endpoint,
			apiKey: patch.apiKey,
		});
		await loadBoschModels();
		void chatPanel.refreshActiveModels();
	} catch (err) {
		boschError = err instanceof Error ? err.message : String(err);
	} finally {
		boschSaving = false;
		renderApp();
	}
}

async function deleteBoschModel(id: string) {
	boschSaving = true;
	boschError = "";
	renderApp();
	try {
		await client.deleteCustomModel(id);
		await loadBoschModels();
		void chatPanel.refreshActiveModels();
	} catch (err) {
		boschError = err instanceof Error ? err.message : String(err);
	} finally {
		boschSaving = false;
		renderApp();
	}
}

async function deleteProviderKey() {
	if (!LLM_KEY_PROVIDERS.has(selectedProvider)) return;
	providerKeySaving = true;
	providerKeyError = "";
	providerSavedNotice = "";
	renderApp();
	try {
		await client.deleteProviderKey(selectedProvider);
		await loadLlmConfig();
	} catch (err) {
		providerKeyError = err instanceof Error ? err.message : String(err);
	} finally {
		providerKeySaving = false;
		renderApp();
	}
}

function filteredSessions(): SessionInfo[] {
	const q = sessionFilter.trim().toLowerCase();
	if (!q) return sessions;
	return sessions.filter((s) => (s.preview || "").toLowerCase().includes(q) || (s.title ?? "").toLowerCase().includes(q));
}

function filteredModels() {
	const provider = currentProviderConfig();
	if (!provider) return [];
	const q = modelFilter.trim().toLowerCase();
	if (!q) return provider.models;
	return provider.models.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
}

async function toggleModelActive(modelId: string, active: boolean) {
	const provider = currentProviderConfig();
	if (!provider) return;
	const model = provider.models.find((m) => m.id === modelId);
	if (!model) return;
	model.active = active;
	providerKeyError = "";
	providerSavedNotice = "";
	renderApp();
	try {
		const activeIds = provider.models.filter((m) => m.active).map((m) => m.id);
		await client.setActiveModels(selectedProvider, activeIds);
		void chatPanel.refreshActiveModels();
	} catch (err) {
		model.active = !active; // revert on failure
		providerKeyError = err instanceof Error ? err.message : String(err);
		renderApp();
	}
}

async function commitProviderKey() {
	if (!LLM_KEY_PROVIDERS.has(selectedProvider) || !providerKeyInput.trim()) return;
	providerKeySaving = true;
	providerKeyError = "";
	providerSavedNotice = "";
	renderApp();
	try {
		await client.saveProviderKey(selectedProvider, providerKeyInput.trim());
		providerKeyInput = "";
		await loadLlmConfig();
		providerSavedNotice = "Saved";
	} catch (err) {
		providerKeyError = err instanceof Error ? err.message : String(err);
	} finally {
		providerKeySaving = false;
		renderApp();
	}
}

async function toggleProviderKey(enabled: boolean) {
	if (enabled) {
		await commitProviderKey();
	} else {
		await deleteProviderKey();
	}
}

async function startCodexLogin() {
	codexAuthBusy = true;
	codexAuthError = "";
	renderApp();
	try {
		const login = await client.startCodexLogin();
		codexLoginId = login.loginId;
		codexLoginUrl = login.url;
		window.open(login.url, "_blank", "noopener,noreferrer");
	} catch (err) {
		codexAuthError = err instanceof Error ? err.message : String(err);
	} finally {
		codexAuthBusy = false;
		renderApp();
	}
}

async function submitCodexCode() {
	if (!codexLoginId || !codexLoginCode.trim()) return;
	codexAuthBusy = true;
	codexAuthError = "";
	renderApp();
	try {
		await client.submitCodexLoginCode(codexLoginId, codexLoginCode.trim());
		const deadline = Date.now() + 15000;
		while (Date.now() < deadline) {
			const status = await client.getCodexLoginStatus(codexLoginId);
			if (status?.status === "complete") {
				codexConfigured = true;
				codexLoginId = "";
				codexLoginUrl = "";
				codexLoginCode = "";
				break;
			}
			if (status?.status === "error") {
				codexAuthError = status.error || "Codex login failed";
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 750));
		}
		await refreshCodexStatus();
	} catch (err) {
		codexAuthError = err instanceof Error ? err.message : String(err);
	} finally {
		codexAuthBusy = false;
		renderApp();
	}
}



function toggleWorkspace() {
	workspaceOpen = !workspaceOpen;
	renderApp();
}

async function toggleFolder(path: string) {
	if (expandedFolders.has(path)) {
		expandedFolders.delete(path);
		renderApp();
		return;
	}
	const sap = sapTreeLookup(path);
	if (sap && sap.info.lazy && !sap.info.loaded) {
		sapBusy = `expand:${path}`;
		sapError = "";
		expandedFolders.add(path);
		renderApp();
		try {
			const { ok, error } = await client.expandSapTree(workspaceId!, sap.conn, path);
			if (!ok && error) sapError = error;
			await loadWorkspace(); // refetch tree (+ manifests) so the new children show up.
		} finally {
			sapBusy = "";
			renderApp();
		}
		return;
	}
	expandedFolders.add(path);
	renderApp();
}

// Drops an @-mention for a tree row into the composer. The chat panel owns the
// candidate list, so it resolves the tree path to the matching candidate itself.
function mentionWorkspaceEntry(path: string, isFolder: boolean) {
	(chatPanel as any)?.insertMention?.(path, isFolder ? "directory" : "file");
}

async function openWorkspaceFile(path: string) {
	const sap = sapTreeLookup(path);
	if (sap && sap.info.hasUri) {
		sapBusy = `hydrate:${path}`;
		sapError = "";
		renderApp();
		try {
			const { error } = await client.hydrateSapFile(workspaceId!, sap.conn, path);
			if (error) sapError = error;
			else await loadWorkspace(); // refresh manifests (file is no longer empty).
		} finally {
			sapBusy = "";
			renderApp();
		}
	}
	const title = normalizeWorkspaceArtifactFilename(path);
	(chatPanel as any).openFilePreview?.(path, title);
}

function isDuckDbFile(path: string): boolean {
	return path.toLowerCase().endsWith(".duckdb");
}

async function toggleDatabase(path: string) {
	if (expandedFolders.has(path)) {
		expandedFolders.delete(path);
		renderApp();
		return;
	}
	expandedFolders.add(path);
	if (!databaseTables.has(path)) {
		databaseTables.set(path, await client.getDatabaseTables(path));
	}
	renderApp();
}

function openDatabaseTable(databasePath: string, tableName: string) {
	(chatPanel as any).openTablePreview?.(databasePath, tableName, tableName);
}

function renderDatabaseFile(node: WorkspaceNode, depth: number) {
	const open = expandedFolders.has(node.path);
	const tables = databaseTables.get(node.path);
	return html`<div>
		<button class="w-full text-left px-2 py-1 hover:bg-accent rounded flex items-center gap-1 text-xs" style="padding-left: ${depth * 12 + 2}px" @click=${() => void toggleDatabase(node.path)}>
			<span class="inline-flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:h-4 [&>svg]:w-4">${icon(open ? ChevronDown : ChevronRight, "xs")}</span>
			<span class="inline-flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:h-4 [&>svg]:w-4">${icon(open ? FolderOpen : Folder, "xs")}</span>
			<span class="truncate">${node.name}</span>
		</button>
		${open
			? html`<div>
				${tables
					? tables.length > 0
						? tables.map((table) => html`
							<button class="w-full text-left px-2 py-1 hover:bg-accent rounded flex items-center gap-1 text-xs" style="padding-left: ${(depth + 1) * 12 + 2}px" @click=${() => openDatabaseTable(node.path, table.name)}>
								<span class="inline-flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:h-4 [&>svg]:w-4">${icon(Table2, "xs")}</span>
								<span class="truncate">${table.name}</span>
							</button>
						`)
						: html`<div class="px-2 py-1 text-xs text-muted-foreground" style="padding-left: ${(depth + 1) * 12 + 2}px">No records</div>`
					: html`<div class="px-2 py-1 text-xs text-muted-foreground" style="padding-left: ${(depth + 1) * 12 + 2}px">Loading...</div>`}
			</div>`
			: ""}
	</div>`;
}

function renderArtifacts() {
	const hasFiles = workspaceTree.artifacts.length > 0;
	if (!hasFiles) {
		return html`<div class="text-xs text-muted-foreground px-2 py-1">No artifacts</div>`;
	}
	const q = artifactFilter.trim().toLowerCase();
	const nodes = q ? filterTree(workspaceTree.artifacts, q) : workspaceTree.artifacts;
	if (nodes.length === 0) {
		return html`<div class="text-xs text-muted-foreground px-2 py-1">No matching artifacts</div>`;
	}
	return html`${renderTree(nodes, 0, true, q.length > 0)}`;
}

function renderAcpWorkersPanel() {
	if (!serviceFeatures.agentWorkers) return "";
	const recent = acpJobs.slice(0, 5);
	return html`
		<div class="shrink-0 border-t border-border p-2">
			<div class="mb-1 flex items-center justify-between gap-2">
				<div class="text-xs font-medium text-muted-foreground">Agent Workers</div>
				<div class="flex items-center gap-1">
					<ui5-button
						class="corp-ui5-button corp-tight-icon-button"
						design="Transparent"
						icon="refresh"
						title="Refresh agent workers"
						@click=${() => { void refreshAgentWorkers(false); void refreshAcpJobs(); }}
					></ui5-button>
					<ui5-button
						class="corp-ui5-button corp-tight-icon-button"
						design="Transparent"
						icon=${agentWorkersCollapsed ? "navigation-down-arrow" : "navigation-right-arrow"}
						title=${agentWorkersCollapsed ? "Expand agent workers" : "Collapse agent workers"}
						@click=${() => {
							agentWorkersCollapsed = !agentWorkersCollapsed;
							localStorage.setItem("agentWorkersCollapsed", String(agentWorkersCollapsed));
							renderApp();
						}}
					></ui5-button>
				</div>
			</div>
			${agentWorkersCollapsed ? "" : html`
			<div class="mb-2 flex flex-wrap gap-1.5">
				${agentWorkers.length === 0
					? html`<div class="px-1 py-1 text-xs text-muted-foreground">Loading workers...</div>`
						: agentWorkers.map((worker) => html`
							<ui5-button
								class="corp-ui5-button"
								design="Transparent"
								title=${`${worker.label}: ${worker.connected ? "connected" : "not connected"}`}
								@click=${() => void openAgentWorkerSettingsDialog()}
							>
								<span class="inline-flex items-center gap-1 text-xs">
									<span class="h-1.5 w-1.5 rounded-full ${worker.connected ? "bg-emerald-500" : "bg-red-500"}"></span>
									${worker.label}
								</span>
							</ui5-button>
						`)}
			</div>
			${recent.length === 0
				? html`<div class="px-1 py-1 text-xs text-muted-foreground">No worker jobs</div>`
				: html`
					<div class="flex max-h-32 flex-col gap-1 overflow-y-auto pr-1">
						${recent.map((job) => {
							const canCancel = job.status === "queued" || job.status === "running";
							return html`
								<div class="rounded border border-border/70 bg-muted/20 px-2 py-1.5">
									<div class="flex items-center gap-2">
										<span class="text-xs font-medium text-foreground">${job.agent}</span>
										<span class="rounded bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">${job.status}</span>
										${canCancel ? html`
											<ui5-button
												class="corp-ui5-button corp-tight-icon-button ml-auto"
												design="Negative"
												icon="decline"
												title="Cancel worker"
												@click=${() => void cancelAcpJob(job.id)}
											></ui5-button>
										` : ""}
									</div>
									<div class="mt-1 truncate text-xs text-muted-foreground" title=${job.task}>${job.task}</div>
								</div>
							`;
						})}
					</div>
				`}
			`}
		</div>
	`;
}

function renderAgentWorkerSettings() {
	return html`
		<section class="flex flex-col gap-3">
			<div>
				<div class="text-sm font-medium">Agent workers</div>
				<div class="text-xs text-muted-foreground">Connect each CLI agent with your own account. Worker auth is isolated per user.</div>
			</div>
			<div class="flex flex-col gap-2">
				${agentWorkers.length === 0
					? html`<div class="rounded border border-border p-3 text-xs text-muted-foreground">Loading workers...</div>`
					: agentWorkers.map((worker) => html`
						<div class="flex items-center gap-3 rounded border border-border p-3">
							<div class="min-w-0 flex-1">
								<div class="text-sm font-medium">${worker.label}</div>
								<div class="text-xs text-muted-foreground">
									${worker.connected ? "Connected" : "Not connected"}
									${worker.authMode ? html`<span> · ${worker.authMode}</span>` : ""}
									${worker.accessPolicy?.allowedInDocker ? html`<span> · sandbox enabled</span>` : ""}
								</div>
								${!worker.connected && worker.loginModes && worker.loginModes.length > 1
									? html`
										<div class="mt-2 max-w-xs">
											<ui5-select
												class="corp-ui5-select"
												?disabled=${agentWorkerBusy === worker.id}
												@change=${(e: Event) => {
													connectorLoginModes.set(
														worker.id,
														getUi5SelectValue(e, connectorLoginModes.get(worker.id) ?? worker.loginModes![0]!.id),
													);
												}}
											>
												${worker.loginModes.map((mode) => html`
													<ui5-option
														value=${mode.id}
														?selected=${(connectorLoginModes.get(worker.id) ?? worker.loginModes![0]!.id) === mode.id}
													>
														${mode.label}
													</ui5-option>
												`)}
											</ui5-select>
											<div class="mt-1 text-[11px] text-muted-foreground">
												${worker.loginModes.find(
													(mode) => mode.id === (connectorLoginModes.get(worker.id) ?? worker.loginModes![0]!.id),
												)?.description ?? ""}
											</div>
										</div>
									`
									: ""}
							</div>
							<ui5-button
								class="corp-ui5-button"
								design=${worker.connected ? "Transparent" : "Emphasized"}
								?disabled=${agentWorkerBusy === worker.id}
								@click=${() => worker.connected ? void disconnectAgentWorker(worker.id) : void connectAgentWorker(worker.id)}
							>
								${agentWorkerBusy === worker.id ? "Working..." : worker.connected ? "Disconnect" : "Connect"}
							</ui5-button>
						</div>
					`)}
			</div>
			${agentWorkerLoginOutput ? html`
				<details class="rounded border border-border bg-muted/20 px-3 py-2 text-xs" open>
					<summary class="cursor-pointer text-muted-foreground">Login output</summary>
					<pre class="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-background p-2 text-[11px]">${agentWorkerLoginOutput}</pre>
				</details>
			` : ""}
		</section>
	`;
}

function renderSandboxSettings() {
	const status = workspaceSandboxStatus;
	const statusClass = status?.running || status?.status === "host" ? "bg-emerald-500" : status?.status === "error" || status?.status === "runtime-missing" ? "bg-red-500" : "bg-amber-500";
	const statusText = status ? status.status.replaceAll("-", " ") : "unknown";
	return html`
		<section class="flex flex-col gap-4">
			<div class="flex items-start justify-between gap-3">
				<div>
					<div class="text-sm font-medium">Sandbox</div>
					<div class="text-xs text-muted-foreground">Runtime, container, workspace paths, and mounted host directories for this workspace.</div>
				</div>
				${Ui5Button({
					children: "Refresh",
					ui5Icon: "refresh",
					onClick: () => { void refreshWorkspaceSandbox(); },
					title: "Refresh sandbox status",
				})}
			</div>
			${!status
				? html`<div class="rounded border border-border p-3 text-xs text-muted-foreground">Sandbox status is unavailable.</div>`
				: html`
					<div class="grid grid-cols-2 gap-2">
						<div class="rounded border border-border p-3">
							<div class="text-[11px] uppercase text-muted-foreground">Status</div>
							<div class="mt-1 inline-flex items-center gap-2 text-sm font-medium">
								<span class="h-2 w-2 rounded-full ${statusClass}"></span>
								${statusText}
							</div>
						</div>
						<div class="rounded border border-border p-3">
							<div class="text-[11px] uppercase text-muted-foreground">Mode</div>
							<div class="mt-1 text-sm font-medium">${status.mode}</div>
						</div>
						<div class="rounded border border-border p-3">
							<div class="text-[11px] uppercase text-muted-foreground">Runtime</div>
							<div class="mt-1 text-sm font-medium">${status.runtime}</div>
						</div>
						<div class="rounded border border-border p-3">
							<div class="text-[11px] uppercase text-muted-foreground">Container</div>
							<div class="mt-1 truncate font-mono text-xs" title=${status.container ?? "none"}>${status.container ?? "none"}</div>
						</div>
					</div>
					<div class="rounded border border-border p-3">
						<div class="text-[11px] uppercase text-muted-foreground">Runtime paths</div>
						<div class="mt-2 grid gap-1 font-mono text-xs">
							<div><span class="text-muted-foreground">workspace:</span> ${status.workspacePath}</div>
							${status.usersPath ? html`<div><span class="text-muted-foreground">users:</span> ${status.usersPath}</div>` : ""}
							${status.image ? html`<div><span class="text-muted-foreground">image:</span> ${status.image}</div>` : ""}
						</div>
					</div>
					<div class="rounded border border-border p-3">
						<div class="text-[11px] uppercase text-muted-foreground">Mounts</div>
						${status.mounts.length === 0
							? html`<div class="mt-2 text-xs text-muted-foreground">No container mounts in host mode.</div>`
							: html`
								<div class="mt-2 flex flex-col gap-2">
									${status.mounts.map((mount) => html`
										<div class="rounded bg-muted/30 p-2 font-mono text-[11px]">
											<div class="truncate" title=${mount.host}>${mount.host}</div>
											<div class="text-muted-foreground">to ${mount.container} (${mount.mode})</div>
										</div>
									`)}
								</div>
							`}
					</div>
					${status.error ? html`
						<details class="rounded border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs" open>
							<summary class="cursor-pointer text-destructive">Sandbox error</summary>
							<pre class="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-background p-2 text-[11px]">${status.error}</pre>
						</details>
					` : ""}
				`}
		</section>
	`;
}

function renderConnectorStatusBadge(connector: ConnectorStatus) {
	return html`
		<span class="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-xs text-muted-foreground">
			<span class="h-1.5 w-1.5 rounded-full ${connector.connected ? "bg-emerald-500" : "bg-red-500"}"></span>
			${connector.connected ? "Connected" : "Not connected"}
		</span>
	`;
}

function renderBusinessConnectorSettings(_sap: WorkspaceSettings["sapConnection"]) {
	const allowedConnectors = new Set(workspaceSettings.connectors?.allowed ?? []);
	return html`
		<section class="flex flex-col gap-4">
			<div>
				<div class="text-sm font-medium">Business connectors</div>
				<div class="text-xs text-muted-foreground">Connect user-owned CLI profiles for tools such as SAP ADT and GitHub. These run through core-service, not directly inside agent sandboxes.</div>
			</div>
			<div class="grid grid-cols-1 gap-2">
				${businessConnectors.length === 0
					? html`<div class="rounded border border-border p-3 text-xs text-muted-foreground">Loading connectors...</div>`
					: businessConnectors.map((connector) => html`
						<div class="rounded border border-border p-3">
							<div class="flex items-center gap-3">
								<div class="min-w-0 flex-1">
									<div class="flex flex-wrap items-center gap-2">
										<div class="text-sm font-medium">${connector.label}</div>
										${renderConnectorStatusBadge(connector)}
									</div>
									<div class="mt-1 text-xs text-muted-foreground">
										${connector.authMode}
										<span> · host proxy</span>
										${connector.accessPolicy?.network ? html`<span> · network ${connector.accessPolicy.network}</span>` : ""}
									</div>
									${!connector.connected && connector.loginModes && connector.loginModes.length > 1
										? html`
											<div class="mt-2 max-w-xs">
												<ui5-select
													class="corp-ui5-select"
													?disabled=${businessConnectorBusy === connector.id}
													@change=${(e: Event) => {
														connectorLoginModes.set(
															connector.id,
															getUi5SelectValue(e, connectorLoginModes.get(connector.id) ?? connector.loginModes![0]!.id),
														);
													}}
												>
													${connector.loginModes.map((mode) => html`
														<ui5-option
															value=${mode.id}
															?selected=${(connectorLoginModes.get(connector.id) ?? connector.loginModes![0]!.id) === mode.id}
														>
															${mode.label}
														</ui5-option>
													`)}
												</ui5-select>
												<div class="mt-1 text-[11px] text-muted-foreground">
													${connector.loginModes.find(
														(mode) => mode.id === (connectorLoginModes.get(connector.id) ?? connector.loginModes![0]!.id),
													)?.description ?? ""}
												</div>
											</div>
										`
										: ""}
									</div>
									<ui5-checkbox
										class="corp-ui5-checkbox"
										text="Allow usage"
										name="allowedConnectors"
										value=${connector.id}
										?checked=${allowedConnectors.has(connector.id)}
									></ui5-checkbox>
									<ui5-button
										class="corp-ui5-button"
										design=${connector.connected ? "Transparent" : "Emphasized"}
										?disabled=${businessConnectorBusy === connector.id}
										@click=${() => connector.connected ? void disconnectBusinessConnector(connector.id) : void connectBusinessConnector(connector.id)}
									>
										${businessConnectorBusy === connector.id ? "Working..." : connector.connected ? "Disconnect" : "Connect"}
									</ui5-button>
								</div>
								${connector.id === "sap-adt" ? renderSapAdtPanel() : ""}
						</div>
					`)}
			</div>
			${businessConnectorLoginOutput ? html`
				<details class="rounded border border-border bg-muted/20 px-3 py-2 text-xs" open>
					<summary class="cursor-pointer text-muted-foreground">Connector login output</summary>
					<pre class="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-background p-2 text-[11px]">${businessConnectorLoginOutput}</pre>
				</details>
			` : ""}
		</section>
	`;
}

function renderSapAdtPanel() {
	return html`
		<details class="mt-3 rounded border border-border/70 bg-muted/20 px-3 py-2" open>
			<summary class="cursor-pointer text-xs font-medium text-muted-foreground">SAP ADT connections</summary>
			<div class="mt-3 flex flex-col gap-3">
				<!--IYH1HC SSO add — mode toggle -->
				<div class="flex gap-1">
					<ui5-button
						class="corp-ui5-button"
						design=${sapConnMode === "local" ? "Emphasized" : "Transparent"}
						@click=${() => { sapConnMode = "local"; sapError = ""; if (!sapLocalSystemsLoaded) void loadLocalSystems(); else renderApp(); }}
					>On-Premise (SSO)</ui5-button>
					<ui5-button
						class="corp-ui5-button"
						design=${sapConnMode === "destination" ? "Emphasized" : "Transparent"}
						@click=${() => { sapConnMode = "destination"; sapError = ""; if (!sapDestinationsLoaded) void loadSapDestinations(); else renderApp(); }}
					>BTP destination</ui5-button>
				</div>

				${sapConnMode === "local"
					? html`
						<!--IYH1HC SSO add — local on-prem (Kerberos/SPNEGO) connect form -->
						<div class="flex flex-col gap-2 rounded border border-border/60 bg-background p-2">
							<div class="text-xs font-medium">Add on-premise connection (SSO)</div>
							<ui5-select
								class="corp-ui5-select"
								@change=${(e: Event) => { const v = getUi5SelectValue(e, sapLocalSelected); const sys = sapLocalSystems.find((s) => `${s.systemId}|${s.client ?? ""}` === v); if (sys) selectLocalSystem(sys); renderApp(); }}
							>
								${sapLocalSystems.length === 0
									? html`<ui5-option value="">${sapLocalSystemsLoaded ? "No systems found" : "Load systems..."}</ui5-option>`
									: sapLocalSystems.map((s) => { const key = `${s.systemId}|${s.client ?? ""}`; return html`
										<ui5-option value=${key} ?selected=${sapLocalSelected === key}>
											${s.systemId}${s.client ? ` (${s.client})` : ""}${s.description ? ` — ${s.description}` : ""}
										</ui5-option>
									`; })}
							</ui5-select>
							<div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
								<ui5-input class="corp-ui5-input" placeholder="ADT URL (https://host)" .value=${sapLocalUrl} @input=${(e: Event) => { sapLocalUrl = (e.target as HTMLInputElement & { value: string }).value; }}></ui5-input>
								<ui5-input class="corp-ui5-input" placeholder="SPN (e.g. SAP/S1RSNCAD)" .value=${sapLocalSpn} @input=${(e: Event) => { sapLocalSpn = (e.target as HTMLInputElement & { value: string }).value; }}></ui5-input>
								<ui5-input class="corp-ui5-input" placeholder="Client (e.g. 011)" .value=${sapLocalClient} @input=${(e: Event) => { sapLocalClient = (e.target as HTMLInputElement & { value: string }).value; }}></ui5-input>
								<ui5-input class="corp-ui5-input" placeholder="Language (e.g. EN)" .value=${sapLocalLanguage} @input=${(e: Event) => { sapLocalLanguage = (e.target as HTMLInputElement & { value: string }).value; }}></ui5-input>
								<ui5-input class="corp-ui5-input" placeholder="Alias (e.g. S1R_011)" .value=${sapNewAlias} @input=${(e: Event) => { sapNewAlias = (e.target as HTMLInputElement & { value: string }).value; }}></ui5-input>
							</div>
							<div class="flex items-center gap-2">
								<ui5-button class="corp-ui5-button" ?disabled=${sapBusy !== ""} @click=${() => void loadLocalSystems()}>
									${sapBusy === "local-systems" ? "Loading..." : "Refresh systems"}
								</ui5-button>
								<ui5-button class="corp-ui5-button" design="Emphasized" ?disabled=${sapBusy !== "" || !sapLocalUrl || !sapLocalSpn} @click=${() => void createLocalConnection()}>
									${sapBusy === "create" ? "Connecting..." : "Connect (SSO)"}
								</ui5-button>
							</div>
							<div class="text-[11px] text-muted-foreground">No password — uses your Windows logon (Kerberos/SPNEGO). Runs locally on your machine; on-prem is reached directly (no proxy).</div>
						</div>
					`
					: html`
						<!-- BTP destination connect form -->
						<div class="flex flex-col gap-2 rounded border border-border/60 bg-background p-2">
							<div class="text-xs font-medium">Add connection</div>
							<div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
								<ui5-select
									class="corp-ui5-select"
									@change=${(e: Event) => { sapNewDestination = getUi5SelectValue(e, sapNewDestination); if (!sapNewAlias) sapNewAlias = sapNewDestination; }}
								>
									${sapDestinations.length === 0
										? html`<ui5-option value="">${sapDestinationsLoaded ? "No destinations found" : "Load destinations..."}</ui5-option>`
										: sapDestinations.map((dest) => html`
											<ui5-option value=${dest.name} ?selected=${sapNewDestination === dest.name}>
												${dest.name}${dest.proxyType ? ` (${dest.proxyType})` : ""}
											</ui5-option>
										`)}
								</ui5-select>
								<ui5-input
									class="corp-ui5-input"
									placeholder="Alias (e.g. T4X_011_EN)"
									.value=${sapNewAlias}
									@input=${(e: Event) => { sapNewAlias = (e.target as HTMLInputElement & { value: string }).value; }}
								></ui5-input>
							</div>
							<div class="flex items-center gap-2">
								<ui5-button class="corp-ui5-button" ?disabled=${sapBusy !== ""} @click=${() => void loadSapDestinations()}>
									${sapBusy === "destinations" ? "Loading..." : "Refresh destinations"}
								</ui5-button>
								<ui5-button class="corp-ui5-button" design="Emphasized" ?disabled=${sapBusy !== "" || !sapNewDestination} @click=${() => void createSapConnection()}>
									${sapBusy === "create" ? "Connecting..." : "Connect"}
								</ui5-button>
							</div>
						</div>
					`}

				${sapError ? html`<div class="rounded border border-destructive/40 bg-destructive/5 px-2 py-1 text-[11px] text-destructive">${sapError}</div>` : ""}

				<!--IYH1HC add: On a successful connect this popup auto-closes and the connection's
				     object tree appears in the Artifacts panel. No connection list / Test / Remove here. -->
			</div>
		</details>
	`;
}

const SAP_TYPE_ICON: Record<string, typeof File> = {
	"CLAS/OC": Box,
	"INTF/OI": Plug,
	"PROG/P": FileCode,
	"PROG/I": FileCode,
	"FUGR/F": FolderCog,
	"FUGR/FF": FileCode,
	"TABL/DT": Table2,
	"TABL/DS": Table2,
	"TTYP/DA": Brackets,
	"VIEW/DV": Eye,
	"DDLS/DF": Database,
	"DCLS/DL": ShieldCheck,
	"DTEL/DE": Tag,
	"DOMA/DD": Tags,
	"MSAG/N": MessageSquare,
	"TRAN/T": SquareTerminal,
	"SFPF/5F": FileText,
	"SFPI/5I": Plug,
};

// File-extension → icon map for artifact tree leaves.
const FILE_EXT_ICON: Record<string, typeof File> = {
	html: FileCode, htm: FileCode, css: FileCode, scss: FileCode,
	js: FileCode, mjs: FileCode, cjs: FileCode, ts: FileCode, tsx: FileCode, jsx: FileCode,
	py: FileCode, java: FileCode, abap: FileCode, cds: FileCode, csn: FileCode,
	xml: FileCode, sql: FileCode, c: FileCode, cpp: FileCode, h: FileCode, go: FileCode, rs: FileCode,
	json: FileJson, jsonl: FileJson,
	md: FileText, markdown: FileText, txt: FileText, log: FileText, pdf: FileText, doc: FileText, docx: FileText,
	csv: FileSpreadsheet, tsv: FileSpreadsheet, xls: FileSpreadsheet, xlsx: FileSpreadsheet,
	yaml: FileCog, yml: FileCog, toml: FileCog, ini: FileCog, env: FileCog,
	png: FileImage, jpg: FileImage, jpeg: FileImage, gif: FileImage, svg: FileImage, webp: FileImage, bmp: FileImage, ico: FileImage,
	zip: FileArchive, gz: FileArchive, tar: FileArchive, tgz: FileArchive, "7z": FileArchive, rar: FileArchive,
	ppt: Presentation, pptx: Presentation,
	sh: FileTerminal, bash: FileTerminal, ps1: FileTerminal, bat: FileTerminal, cmd: FileTerminal,
	mp3: FileAudio, wav: FileAudio, ogg: FileAudio, m4a: FileAudio,
	mp4: FilePlay, mov: FilePlay, avi: FilePlay, webm: FilePlay, mkv: FilePlay,
};

function fileIconFor(name: string): typeof File {
	const ext = name.split(".").pop()?.toLowerCase() ?? "";
	return FILE_EXT_ICON[ext] ?? File;
}

function isSapObjectTreeFolder(path: string): boolean {
	for (const conn of sapTreeManifests.keys()) {
		if (path.includes(`/artifacts/${conn}/Local Object ($TMP)`)) return true;
	}
	return false;
}

function countSapObjects(node: WorkspaceNode): number {
	if (node.type !== "directory") return 1;
	return (node.children ?? []).reduce((sum, c) => sum + countSapObjects(c), 0);
}

function sapDisplayName(node: WorkspaceNode, info: SapTreeManifestEntry | undefined): string {
	if (info?.label) return info.label;
	const base = node.name.split(".")[0] ?? node.name;
	return base.replace(/#/g, "/").toUpperCase();
}

// Hover-revealed download/delete buttons for one workspace tree row (artifacts or skills).
function renderNodeActions(path: string, isFolder: boolean) {
	return html`
		<button class="shrink-0 opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-secondary text-muted-foreground transition-opacity [&>svg]:h-3.5 [&>svg]:w-3.5" title="Mention in chat"
			@click=${(e: Event) => { e.stopPropagation(); mentionWorkspaceEntry(path, isFolder); }}>${icon(AtSign, "xs")}</button>
		<button class="shrink-0 opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-secondary text-muted-foreground transition-opacity [&>svg]:h-3.5 [&>svg]:w-3.5" title=${isFolder ? "Download as .zip" : "Download"}
			@click=${(e: Event) => { e.stopPropagation(); void downloadWorkspaceEntry(path, isFolder); }}>${icon(Download, "xs")}</button>
		<button class="shrink-0 opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-destructive/10 text-destructive transition-opacity [&>svg]:h-3.5 [&>svg]:w-3.5" title="Delete"
			@click=${(e: Event) => { e.stopPropagation(); void deleteWorkspaceEntry(path, isFolder); }}>${icon(Trash2, "xs")}</button>`;
}

// Filter the loaded tree by name (case-insensitive). A directory-name match keeps
// its whole subtree; a leaf also matches on the SAP ADT display label. Only operates
// on already-loaded nodes — never triggers lazy ADT expansion.
function filterTree(nodes: WorkspaceNode[], q: string): WorkspaceNode[] {
	const out: WorkspaceNode[] = [];
	for (const node of nodes) {
		if (node.type === "directory") {
			if (node.name.toLowerCase().includes(q)) {
				out.push(node);
				continue;
			}
			const children = filterTree(node.children ?? [], q);
			if (children.length > 0) out.push({ ...node, children });
			continue;
		}
		const sap = sapTreeLookup(node.path);
		const label = sap ? sapDisplayName(node, sap.info) : node.name;
		if (label.toLowerCase().includes(q) || node.name.toLowerCase().includes(q)) out.push(node);
	}
	return out;
}

function renderTree(nodes: WorkspaceNode[], depth = 0, withActions = false, forceOpen = false) {
	return nodes.map((node) => {
		if (node.type === "directory") {
			const open = forceOpen || expandedFolders.has(node.path);
			const isSapFolder = isSapObjectTreeFolder(node.path);
			const expanding = sapBusy === `expand:${node.path}`;
			const count = isSapFolder ? countSapObjects(node) : -1;
			return html`<div>
				<div class="group w-full px-2 py-1 hover:bg-accent rounded flex items-center gap-1 text-xs" style="padding-left: ${depth * 12 + 2}px">
					<button class="flex-1 min-w-0 text-left flex items-center gap-1" @click=${() => void toggleFolder(node.path)}>
						<span class="inline-flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:h-4 [&>svg]:w-4">${expanding ? icon(LoaderCircle, "xs", "animate-spin") : icon(open ? ChevronDown : ChevronRight, "xs")}</span>
						<span class="inline-flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:h-4 [&>svg]:w-4">${icon(open ? FolderOpen : Folder, "xs")}</span>
						<span class="truncate">${node.name}</span>
						${count >= 0 ? html`<span class="shrink-0 text-[11px] text-muted-foreground">(${count})</span>` : ""}
					</button>
					${withActions && !isSapFolder ? renderNodeActions(node.path, true) : ""}
				</div>
				${open && node.children ? html`<div>${renderTree(node.children, depth + 1, withActions, forceOpen)}</div>` : ""}
			</div>`;
		}
		if (isDuckDbFile(node.path)) {
			return renderDatabaseFile(node, depth);
		}
		const sap = sapTreeLookup(node.path);
		if (sap?.info.hasUri) {
			const hydrating = sapBusy === `hydrate:${node.path}`;
			const leafIcon = (sap.info.typeId && SAP_TYPE_ICON[sap.info.typeId]) || File;
			return html`<button class="w-full text-left px-2 py-1 hover:bg-accent rounded flex items-center gap-1 text-xs" style="padding-left: ${depth * 12 + 2}px" @click=${() => void openWorkspaceFile(node.path)}>
				<span class="inline-flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:h-4 [&>svg]:w-4">${hydrating ? icon(LoaderCircle, "xs", "animate-spin") : icon(leafIcon, "xs")}</span>
				<span class="truncate">${sapDisplayName(node, sap.info)}</span>
				${sap.info.description ? html`<span class="truncate text-[11px] italic text-muted-foreground">${sap.info.description}</span>` : ""}
			</button>`;
		}
		return html`<div class="group w-full px-2 py-1 hover:bg-accent rounded flex items-center gap-1 text-xs" style="padding-left: ${depth * 12 + 2}px">
			<button class="flex-1 min-w-0 text-left flex items-center gap-1" @click=${() => void openWorkspaceFile(node.path)}>
				<span class="inline-flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:h-4 [&>svg]:w-4">${icon(fileIconFor(node.name), "xs")}</span>
				<span class="truncate">${node.name}</span>
			</button>
			${withActions ? renderNodeActions(node.path, false) : ""}
		</div>`;
	});
}
function formatTime(ms: number): string {
	const diff = Date.now() - ms;
	if (diff < 60_000) return "just now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	return `${Math.floor(diff / 86_400_000)}d ago`;
}

function getWorkspaceEventSchedule(event: WorkspaceScheduledEvent): string {
	if (!event.valid) return "Invalid event file";
	if (event.type === "periodic") return `${event.schedule ?? "No schedule"}${event.timezone ? ` · ${event.timezone}` : ""}`;
	if (event.type === "one-shot") return event.at ?? "No trigger time";
	if (event.type === "immediate") return "Immediate";
	return event.type || "Unknown";
}

function getWorkspaceEventTypeLabel(event: WorkspaceScheduledEvent): string {
	if (!event.valid) return "invalid";
	if (event.type === "periodic") return "recurring";
	if (event.type === "one-shot") return "one-time";
	if (event.type === "immediate") return "immediate";
	return event.type || "unknown";
}

function renderWorkspaceEventsDialog() {
	if (!serviceFeatures.reminders) return "";
	if (!workspaceEventsDialogOpen) return "";
	return html`
		<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4" @click=${closeWorkspaceEventsDialog}>
			<div class="w-full max-w-2xl rounded border border-border bg-background shadow-xl" @click=${(e: Event) => e.stopPropagation()}>
				<div class="flex items-center justify-between border-b border-border px-4 py-3">
					<div>
						<div class="text-sm font-semibold">Scheduled events</div>
						<div class="text-xs text-muted-foreground">Workspace reminders and recurring wakeups</div>
					</div>
					<div class="flex items-center gap-2">
						${Ui5Button({
							className: "corp-tight-icon-button",
							ui5Icon: "refresh",
							onClick: () => void refreshWorkspaceEvents(),
							title: "Refresh scheduled events",
						})}
						${Ui5Button({ className: "corp-tight-icon-button", ui5Icon: "decline", onClick: closeWorkspaceEventsDialog, title: "Close" })}
					</div>
				</div>
				<div class="max-h-[65vh] overflow-y-auto p-4">
					${workspaceEventsBusy
						? html`<div class="text-sm text-muted-foreground">Loading scheduled events...</div>`
						: workspaceEvents.length === 0
							? html`<div class="rounded border border-border bg-muted/20 px-3 py-4 text-sm text-muted-foreground">No scheduled events in this workspace.</div>`
							: html`
								<div class="flex flex-col gap-2">
									${workspaceEvents.map((event) => html`
										<div class="rounded border border-border bg-background p-3">
											<div class="flex items-start justify-between gap-3">
												<div class="min-w-0 flex-1">
													<div class="flex flex-wrap items-center gap-2">
														<span class="text-sm font-medium">${event.text || event.filename}</span>
														<span class="rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">${getWorkspaceEventTypeLabel(event)}</span>
													</div>
													<div class="mt-1 text-xs text-muted-foreground">${getWorkspaceEventSchedule(event)}</div>
													<div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
														<span class="font-mono">${event.filename}</span>
														${event.channelId ? html`<span>Session: <span class="font-mono">${event.channelId}</span></span>` : ""}
														${event.modifiedAt ? html`<span>Updated ${formatTime(event.modifiedAt)}</span>` : ""}
													</div>
													${event.error ? html`<div class="mt-2 text-xs text-destructive">${event.error}</div>` : ""}
												</div>
												<button
													class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border border-border text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
													title="Cancel scheduled event"
													?disabled=${workspaceEventsBusy}
													@click=${() => void deleteWorkspaceEvent(event.filename)}
												>
													${icon(Trash2, "xs")}
												</button>
											</div>
										</div>
									`)}
								</div>
							`}
					${workspaceEventsError ? html`<div class="mt-3 text-xs text-destructive">${workspaceEventsError}</div>` : ""}
				</div>
				<div class="flex justify-end border-t border-border px-4 py-3">
					${Ui5Button({ children: "Close", onClick: closeWorkspaceEventsDialog })}
				</div>
			</div>
		</div>
	`;
}

function renderUserMenu() {
	if (!currentUser) return "";
	return html`
		<div class="relative">
			${Ui5Button({
				className: "corp-icon-button",
				ui5Icon: "employee",
				onClick: () => { userMenuOpen = !userMenuOpen; themeMenuOpen = false; renderApp(); },
				title: "User menu",
			})}
			${userMenuOpen
				? html`
					<div class="absolute right-0 top-10 z-50 w-56 rounded border border-border bg-background shadow-lg">
						<div class="border-b border-border px-3 py-2">
							<div class="truncate text-sm font-medium">${currentUser.displayName}</div>
							<div class="truncate text-xs text-muted-foreground">${currentUser.email}</div>
						</div>
						<ui5-button class="corp-ui5-button corp-menu-button" design="Transparent" @click=${openProviderDialog}>
							${icon(KeyRound, "xs")}
							<span>LLM provider</span>
						</ui5-button>
						${ssoConfig.hideAuthUi ? "" : html`
						<ui5-button class="corp-ui5-button corp-menu-button" design="Transparent" @click=${() => void logout()}>
							${icon(LogOut, "xs")}
							<span>Logout</span>
						</ui5-button>`}<!--IYH1HC add: hide Logout under XSUAA edge auth-->
					</div>
				`
				: ""}
		</div>
	`;
}

function renderCreateWorkspaceDialog() {
	if (!createWorkspaceDialogOpen) return "";
	const templates = workspaceTemplates;
	const selectedTemplate = templates.find((template) => template.id === newWorkspaceTemplateId) ?? templates[0];
	return html`
		<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4" @click=${closeCreateWorkspaceDialog}>
			<form class="w-full max-w-xl rounded border border-border bg-background shadow-xl" @submit=${submitCreateWorkspace} @click=${(e: Event) => e.stopPropagation()}>
				<div class="flex items-center justify-between border-b border-border px-4 py-3">
					<div>
						<div class="text-sm font-semibold">New workspace</div>
						<div class="text-xs text-muted-foreground">Choose a type to preconfigure skills, connector policy, and sandbox image.</div>
					</div>
					${Ui5Button({ className: "corp-tight-icon-button", ui5Icon: "decline", onClick: closeCreateWorkspaceDialog, title: "Close" })}
				</div>
				<div class="flex flex-col gap-4 p-4">
					<label class="flex flex-col gap-1">
						<span class="text-xs font-medium text-muted-foreground">Name</span>
						<ui5-input
							class="corp-ui5-input"
							value=${newWorkspaceName}
							placeholder="Workspace name"
							?disabled=${newWorkspaceBusy}
							@input=${(e: Event) => { newWorkspaceName = getUi5Value(e); }}
						></ui5-input>
					</label>
					<label class="flex flex-col gap-1">
						<span class="text-xs font-medium text-muted-foreground">Type</span>
						<ui5-select
							class="corp-ui5-select"
							?disabled=${newWorkspaceBusy || templates.length === 0}
							@change=${(e: Event) => { newWorkspaceTemplateId = getUi5SelectValue(e, newWorkspaceTemplateId); renderApp(); }}
						>
							${templates.map((template) => html`
								<ui5-option value=${template.id} ?selected=${template.id === newWorkspaceTemplateId}>${template.label}</ui5-option>
							`)}
						</ui5-select>
					</label>
					${selectedTemplate ? html`
						<div class="rounded border border-border p-3">
							<div class="text-sm font-medium">${selectedTemplate.label}</div>
							<div class="mt-1 text-xs text-muted-foreground">${selectedTemplate.description}</div>
							<div class="mt-3 grid gap-2 text-xs">
								<div><span class="text-muted-foreground">Sandbox image:</span> <span class="font-mono">${selectedTemplate.sandboxImage}</span></div>
								<div>
									<span class="text-muted-foreground">Skills:</span>
									${selectedTemplate.skills.length === 0
										? html`<span> none</span>`
										: html`
											<div class="mt-1 flex flex-wrap gap-1">
												${selectedTemplate.skills.map((skill) => html`
													<span class="rounded-full border border-border px-2 py-0.5">${skill.label}</span>
												`)}
											</div>
										`}
								</div>
							</div>
						</div>
					` : html`<div class="rounded border border-border p-3 text-xs text-muted-foreground">Workspace types are unavailable.</div>`}
					${newWorkspaceError ? html`<div class="text-xs text-destructive">${newWorkspaceError}</div>` : ""}
				</div>
				<div class="flex justify-end gap-2 border-t border-border px-4 py-3">
					${Ui5Button({ children: "Cancel", onClick: closeCreateWorkspaceDialog, disabled: newWorkspaceBusy })}
					<ui5-button
						class="corp-ui5-button"
						design="Emphasized"
						?disabled=${newWorkspaceBusy || templates.length === 0}
						@click=${submitCreateWorkspace}
					>
						${newWorkspaceBusy ? "Creating..." : "Create"}
					</ui5-button>
				</div>
			</form>
		</div>
	`;
}

function renderSkillUploadDialog() {
	if (!skillUploadDialogOpen) return "";
	const previewPaths = skillUploadFiles.slice(0, 8);
	const canUpload = !skillUploadReading && !skillUploadBusy && skillUploadFiles.length > 0;
	return html`
		<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4" @click=${closeSkillUploadDialog}>
			<form class="w-full max-w-xl rounded border border-border bg-background shadow-xl" @submit=${submitSkillUpload} @click=${(e: Event) => e.stopPropagation()}>
				<div class="flex items-center justify-between border-b border-border px-4 py-3">
					<div>
						<div class="text-sm font-semibold">Browser Skills</div>
						<div class="text-xs text-muted-foreground">The whole folder is copied into this workspace's skills, keeping its structure.</div>
					</div>
					${Ui5Button({ className: "corp-tight-icon-button", ui5Icon: "decline", onClick: closeSkillUploadDialog, title: "Close" })}
				</div>
				<div class="flex flex-col gap-3 p-4">
					<div class="grid gap-1 text-xs">
						<div><span class="text-muted-foreground">Skill name:</span> <span class="font-mono">${skillUploadFolderName}</span></div>
						<div>
							<span class="text-muted-foreground">Contents:</span>
							${skillUploadReading ? html`<span> reading files...</span>` : html`<span> ${skillUploadFiles.length} files, ${formatBytes(skillUploadBytes)}</span>`}
						</div>
					</div>
					${previewPaths.length > 0 ? html`
						<div class="max-h-[35vh] overflow-y-auto rounded border border-border p-3 font-mono text-xs">
							${previewPaths.map((file) => html`<div class="truncate">${file.path}</div>`)}
							${skillUploadFiles.length > previewPaths.length
								? html`<div class="text-muted-foreground">and ${skillUploadFiles.length - previewPaths.length} more...</div>`
								: ""}
						</div>
					` : ""}
					${skillUploadSkipped.length > 0
						? html`<div class="text-xs text-muted-foreground">Skipped ${skillUploadSkipped.length} file(s): ${skillUploadSkipped.slice(0, 3).join(", ")}${skillUploadSkipped.length > 3 ? ", ..." : ""}</div>`
						: ""}
					${skillUploadError ? html`<div class="text-xs text-destructive">${skillUploadError}</div>` : ""}
				</div>
				<div class="flex justify-end gap-2 border-t border-border px-4 py-3">
					${Ui5Button({ children: "Cancel", onClick: closeSkillUploadDialog, disabled: skillUploadBusy || skillUploadReading })}
					<ui5-button class="corp-ui5-button" design="Emphasized" ?disabled=${!canUpload} @click=${submitSkillUpload}>
						${skillUploadBusy ? "Uploading..." : "Upload"}
					</ui5-button>
				</div>
			</form>
		</div>
	`;
}

function renderProviderDialog() {
	if (!providerDialogOpen) return "";
	const allProviders = [
		{ id: "bosch-genai", label: "Bosch GenAI" },
		{ id: "openai-codex", label: "Codex" },
		{ id: "openai", label: "OpenAI" },
		{ id: "google", label: "Google Gemini" },
		{ id: "anthropic", label: "Anthropic" },
		{ id: "sap-openai", label: "SAP OpenAI" },
		{ id: "sap-claude", label: "SAP Claude" },
	];
	const allowedProviders = serviceFeatures.llmProviders;
	const providers = allowedProviders ? allProviders.filter((p) => allowedProviders.includes(p.id)) : allProviders;
	if (providers.length > 0 && !providers.some((p) => p.id === selectedProvider)) {
		selectedProvider = providers[0]!.id;
		localStorage.setItem(providerKey, selectedProvider);
	}
	return html`
		<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4" @click=${closeProviderDialog}>
			<div class="w-full max-w-2xl rounded border border-border bg-background shadow-xl" @click=${(e: Event) => e.stopPropagation()}>
				<div class="flex items-center justify-between border-b border-border px-4 py-3">
					<div class="text-sm font-semibold">LLM provider</div>
					${Ui5Button({ className: "corp-tight-icon-button", ui5Icon: "decline", onClick: closeProviderDialog, title: "Close" })}
				</div>
				<div class="flex max-h-[70vh] flex-col gap-4 overflow-y-auto p-4">
					<label class="flex flex-col gap-1">
						<span class="text-xs font-medium text-muted-foreground">Provider</span>
						<ui5-select
							class="corp-ui5-select"
							@change=${(e: Event) => setProvider(getUi5SelectValue(e, selectedProvider))}
						>
							${providers.map((provider) => html`<ui5-option value=${provider.id} ?selected=${provider.id === selectedProvider}>${provider.label}</ui5-option>`)}
						</ui5-select>
					</label>

					${selectedProvider === "openai-codex"
						? html`
							<div class="rounded border border-border p-3">
								<div class="mb-3 flex items-center justify-between gap-2">
									<div>
										<div class="text-sm font-medium">Codex OAuth</div>
										<div class="text-xs text-muted-foreground">${codexConfigured ? "Authenticated" : "Not authenticated"}</div>
									</div>
									<ui5-button
										class="corp-ui5-button"
										design="Transparent"
										?disabled=${codexAuthBusy}
										@click=${() => void startCodexLogin()}
									>
										${codexConfigured ? "Re-auth" : "Auth"}
									</ui5-button>
								</div>
								${codexLoginUrl
									? html`
										<div class="flex flex-col gap-2">
											<a class="truncate text-xs text-primary underline" href=${codexLoginUrl} target="_blank" rel="noopener noreferrer">${codexLoginUrl}</a>
											<ui5-input
												class="corp-ui5-input"
												placeholder="Paste code or redirect URL"
												value=${codexLoginCode}
												@input=${(e: Event) => { codexLoginCode = getUi5Value(e); }}
											></ui5-input>
											<ui5-button
												class="corp-ui5-button corp-wide-button"
												design="Emphasized"
												?disabled=${codexAuthBusy || !codexLoginCode.trim()}
												@click=${() => void submitCodexCode()}
											>
												${codexAuthBusy ? "Checking..." : "Finish login"}
											</ui5-button>
										</div>
									`
									: ""}
								${codexAuthError ? html`<div class="mt-2 text-xs text-destructive">${codexAuthError}</div>` : ""}
							</div>
						`
						: ""}

					${selectedProvider === "bosch-genai" ? renderBoschGenAIConfig() : ""}

					${LLM_KEY_PROVIDERS.has(selectedProvider) ? renderLlmKeyAndModels() : ""}
				</div>
			</div>
		</div>
	`;
}

// Bosch GenAI setup — manage multiple custom model blocks (LLM Farm).
// Each block { name, provider, endpoint, API key } points at a custom gateway endpoint;
// the API key is encrypted server-side (same mechanism as the cloud providers). Saved
// blocks appear by name in the chatbox model listbox.
const BOSCH_BASE_PROVIDERS = [
	{ id: "openai", label: "OpenAI" },
	{ id: "google", label: "Google Gemini" },
	{ id: "anthropic", label: "Anthropic" },
];

function renderBoschGenAIConfig() {
	return html`
		<div class="flex flex-col gap-3">
			<p class="text-xs text-muted-foreground">
				Configure models served through your Bosch GenAI / LLM Farm gateway. Each entry calls the chosen
				provider's API format but is routed to your endpoint. Saved entries appear in the model picker.
			</p>

			<!-- Configured blocks -->
			<div class="flex flex-col gap-3">
				${boschLoading
					? html`<div class="px-3 py-4 text-center text-xs italic text-muted-foreground">Loading models...</div>`
					: boschModels.length === 0
						? html`<div class="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs italic text-muted-foreground">No models configured yet.</div>`
						: boschModels.map((model) => renderBoschModelBlock(model))}
			</div>

			<!-- Add new block -->
			<div class="rounded-lg border border-border bg-card">
				<div class="flex items-center gap-2 px-3 py-2">
					<span class="text-sm font-semibold">Add model</span>
				</div>
				<div class="flex flex-col gap-2 border-t border-border px-3 py-3">
					<ui5-input
						class="corp-ui5-input"
						placeholder="Name (e.g. LLM Farm GPT-5-nano)"
						value=${boschDraft.name}
						?disabled=${boschSaving}
						@input=${(e: Event) => { boschDraft.name = getUi5Value(e); }}
					></ui5-input>
					<ui5-select
						class="corp-ui5-select"
						?disabled=${boschSaving}
						@change=${(e: Event) => { boschDraft.baseProvider = getUi5SelectValue(e, boschDraft.baseProvider); }}
					>
						${BOSCH_BASE_PROVIDERS.map((p) => html`<ui5-option value=${p.id} ?selected=${p.id === boschDraft.baseProvider}>${p.label}</ui5-option>`)}
					</ui5-select>
					<ui5-input
						class="corp-ui5-input"
						placeholder="Endpoint (full model URL from LLM Farm docs)"
						value=${boschDraft.endpoint}
						?disabled=${boschSaving}
						@input=${(e: Event) => { boschDraft.endpoint = getUi5Value(e); }}
					></ui5-input>
					<ui5-input
						class="corp-ui5-input"
						type="Password"
						placeholder="API Key"
						value=${boschDraft.apiKey}
						?disabled=${boschSaving}
						@input=${(e: Event) => { boschDraft.apiKey = getUi5Value(e); }}
					></ui5-input>
					<ui5-button
						class="corp-ui5-button corp-wide-button"
						design="Emphasized"
						?disabled=${boschSaving}
						@click=${() => void addBoschModel()}
					>
						${boschSaving ? "Saving..." : "Add model"}
					</ui5-button>
				</div>
			</div>

			${boschError ? html`<div class="text-xs text-destructive">${boschError}</div>` : ""}
		</div>
	`;
}

function renderBoschModelBlock(model: CustomModelConfig) {
	const open = boschExpanded[model.id] === true;
	return html`
		<div class="rounded-lg border border-border bg-card">
			<div class="flex items-center gap-2 px-3 py-2">
				<button
					type="button"
					class="flex min-w-0 flex-1 items-center gap-2 text-left hover:opacity-80"
					@click=${() => { boschExpanded[model.id] = !open; renderApp(); }}
				>
					${icon(open ? ChevronDown : ChevronRight, "xs")}
					<span class="min-w-0 flex-1 truncate text-sm font-medium">${model.name}</span>
				</button>
			</div>
			${open ? html`
			<div class="flex flex-col gap-2 border-t border-border px-3 py-3">
				<ui5-input
					class="corp-ui5-input"
					placeholder="Name"
					value=${model.name}
					?disabled=${boschSaving}
					@change=${(e: Event) => { const v = getUi5Value(e); if (v.trim() && v.trim() !== model.name) void updateBoschModel(model, { name: v.trim() }); }}
				></ui5-input>
				<ui5-select
					class="corp-ui5-select"
					?disabled=${boschSaving}
					@change=${(e: Event) => { const v = getUi5SelectValue(e, model.baseProvider); if (v !== model.baseProvider) void updateBoschModel(model, { baseProvider: v }); }}
				>
					${BOSCH_BASE_PROVIDERS.map((p) => html`<ui5-option value=${p.id} ?selected=${p.id === model.baseProvider}>${p.label}</ui5-option>`)}
				</ui5-select>
				<ui5-input
					class="corp-ui5-input"
					placeholder="Endpoint (full model URL from LLM Farm docs)"
					value=${model.endpoint}
					?disabled=${boschSaving}
					@change=${(e: Event) => { const v = getUi5Value(e); if (v.trim() && v.trim() !== model.endpoint) void updateBoschModel(model, { endpoint: v.trim() }); }}
				></ui5-input>
				<ui5-input
					class="corp-ui5-input"
					type="Password"
					placeholder="Replace API Key (leave blank to keep)"
					?disabled=${boschSaving}
					@change=${(e: Event) => { const v = getUi5Value(e); if (v.trim()) void updateBoschModel(model, { apiKey: v.trim() }); }}
				></ui5-input>
				<ui5-button
					class="corp-ui5-button corp-wide-button"
					design="Negative"
					icon="delete"
					?disabled=${boschSaving}
					@click=${() => { if (confirm(`Remove model "${model.name}"? This deletes it permanently.`)) void deleteBoschModel(model.id); }}
				>
					Remove
				</ui5-button>
			</div>
			` : ""}
		</div>
	`;
}

function renderLlmKeyAndModels() {
	const provider = currentProviderConfig();
	const hasKey = provider?.hasKey === true;
	const label = provider?.label ?? selectedProvider;
	const allModels = provider?.models ?? [];
	const visible = filteredModels();
	const enabledCount = allModels.filter((m) => m.active).length;

	const keyDocsUrl = selectedProvider === "google"
		? "https://aistudio.google.com/apikey"
		: selectedProvider === "openai"
			? "https://platform.openai.com/api-keys"
			: "https://console.anthropic.com/settings/keys";

	return html`
		<div class="flex flex-col gap-3">
			<!-- Models -->
			<div class="rounded-lg border border-border bg-card">
				<div class="flex items-center gap-2 px-3 py-2">
					<span class="text-sm font-semibold">Models</span>
					<span class="text-xs text-muted-foreground">${enabledCount} enabled</span>
					<span class="ml-auto"></span>
					${Ui5Button({
						className: "corp-tight-icon-button",
						ui5Icon: "refresh",
						onClick: () => void loadLlmConfig(),
						disabled: llmConfigLoading,
						title: "Refresh models",
					})}
				</div>
				<div class="px-3 pb-2">
					<ui5-input
						class="corp-ui5-input"
						placeholder="Add or search model"
						show-clear-icon
						value=${modelFilter}
						@input=${(e: Event) => { modelFilter = getUi5Value(e); renderApp(); }}
					></ui5-input>
				</div>
				${llmConfigLoading
					? html`<div class="px-3 py-4 text-center text-xs italic text-muted-foreground">Loading models...</div>`
					: allModels.length === 0
						? html`<div class="px-3 py-4 text-center text-xs italic text-muted-foreground">No models available for this provider.</div>`
						: html`
							<div class="max-h-64 overflow-y-auto">
								${visible.length === 0
									? html`<div class="px-3 py-3 text-center text-xs italic text-muted-foreground">No match.</div>`
									: visible.map((model) => html`
										<div class="flex items-center gap-3 border-t border-border px-3 py-2">
											<div class="min-w-0 flex-1">
												<div class="truncate text-sm">${model.name}</div>
												<div class="corp-mono truncate text-xs text-muted-foreground">${model.id}</div>
											</div>
											<ui5-switch
												class="corp-ui5-switch"
												?checked=${model.active}
												?disabled=${providerKeySaving}
												@change=${(e: Event) => void toggleModelActive(model.id, (e.target as HTMLInputElement & { checked: boolean }).checked)}
											></ui5-switch>
										</div>
									`)}
							</div>
						`}
			</div>

			<!-- API Keys (collapsible) -->
			<div class="rounded-lg border border-border bg-card">
				<button
					type="button"
					class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent"
					@click=${() => { apiKeysExpanded = !apiKeysExpanded; renderApp(); }}
				>
					${icon(apiKeysExpanded ? ChevronDown : ChevronRight, "xs")}
					<span class="text-sm font-semibold">API Keys</span>
					${hasKey
						? html`<span class="ml-auto inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium" style="color: var(--sapPositiveColor, #256f3a); background: var(--sapSuccessBackgroundColor, rgba(37,111,58,0.1));">Stored</span>`
						: html`<span class="ml-auto text-xs text-muted-foreground">Required</span>`}
				</button>
				${apiKeysExpanded
					? html`
						<div class="flex flex-col gap-2 border-t border-border px-3 py-3">
							<div class="flex items-center gap-2">
								<div class="min-w-0 flex-1">
									<div class="text-sm font-medium">${label} API Key</div>
									<div class="text-xs text-muted-foreground">
										${hasKey ? "A key is stored (encrypted)." : "You can put in your own key to use these models at cost."}
									</div>
								</div>
								<ui5-switch
									class="corp-ui5-switch"
									?checked=${hasKey}
									?disabled=${providerKeySaving}
									@change=${(e: Event) => void toggleProviderKey((e.target as HTMLInputElement & { checked: boolean }).checked)}
								></ui5-switch>
							</div>
							<ui5-input
								class="corp-ui5-input"
								type="Password"
								placeholder=${hasKey ? `Replace your ${label} API Key` : `Enter your ${label} API Key`}
								value=${providerKeyInput}
								?disabled=${providerKeySaving}
								@input=${(e: Event) => { providerKeyInput = getUi5Value(e); providerSavedNotice = ""; }}
								@change=${() => void commitProviderKey()}
							></ui5-input>
							<div class="flex items-center gap-2">
								<span class="text-xs text-muted-foreground">
									Get a key at <a class="text-primary underline" href=${keyDocsUrl} target="_blank" rel="noopener noreferrer">${new URL(keyDocsUrl).host}</a>.
								</span>
								${providerSavedNotice ? html`<span class="ml-auto text-xs font-medium" style="color: var(--sapPositiveColor, #256f3a);">${providerSavedNotice}</span>` : ""}
							</div>
						</div>
					`
					: ""}
			</div>

			${providerKeyError ? html`<div class="text-xs text-destructive">${providerKeyError}</div>` : ""}
		</div>
	`;
}

function filteredTools(): ToolCatalogEntry[] {
	const query = toolFilter.trim().toLowerCase();
	if (!query) return toolCatalog;
	return toolCatalog.filter((tool) =>
		`${tool.name} ${tool.label} ${tool.group} ${tool.description}`.toLowerCase().includes(query),
	);
}

function setToolEnabled(name: string, enabled: boolean) {
	const next = new Set(workspaceToolsDraft);
	if (enabled) next.add(name);
	else next.delete(name);
	workspaceToolsDraft = next;
	renderApp();
}

// Select all / Deselect all act on the filtered rows, so they do what the user
// sees rather than silently touching tools hidden by the search box.
function setFilteredToolsEnabled(enabled: boolean) {
	const next = new Set(workspaceToolsDraft);
	for (const tool of filteredTools()) {
		if (enabled) {
			if (tool.available) next.add(tool.name);
		} else {
			next.delete(tool.name);
		}
	}
	workspaceToolsDraft = next;
	renderApp();
}

function renderToolSettings() {
	const visible = filteredTools();
	const enabledCount = toolCatalog.filter((tool) => workspaceToolsDraft.has(tool.name)).length;

	return html`
		<section class="flex min-h-[52vh] flex-col gap-3">
			<div>
				<div class="text-sm font-medium">Tools</div>
				<div class="text-xs text-muted-foreground">
					The agent only sees, and may only call, the tools enabled here. Applies to this workspace and its subagents.
				</div>
			</div>
			<div class="rounded-lg border border-border bg-card">
				<div class="flex items-center gap-2 px-3 py-2">
					<span class="text-sm font-semibold">Available tools</span>
					<span class="text-xs text-muted-foreground">${enabledCount} of ${toolCatalog.length} enabled</span>
					<span class="ml-auto"></span>
					${Ui5Button({ children: "Select all", onClick: () => setFilteredToolsEnabled(true) })}
					${Ui5Button({ children: "Deselect all", onClick: () => setFilteredToolsEnabled(false) })}
				</div>
				<div class="px-3 pb-2">
					<ui5-input
						class="corp-ui5-input"
						placeholder="Search tool"
						show-clear-icon
						value=${toolFilter}
						@input=${(e: Event) => { toolFilter = getUi5Value(e); renderApp(); }}
					></ui5-input>
				</div>
				${toolCatalog.length === 0
					? html`<div class="px-3 py-4 text-center text-xs italic text-muted-foreground">Could not load the tool catalog.</div>`
					: html`
						<div class="max-h-[38vh] overflow-y-auto">
							${visible.length === 0
								? html`<div class="px-3 py-3 text-center text-xs italic text-muted-foreground">No match.</div>`
								: visible.map((tool) => html`
									<div class="flex items-center gap-3 border-t border-border px-3 py-2">
										<div class="min-w-0 flex-1">
											<div class="flex items-center gap-2">
												<span class="corp-mono truncate text-sm">${tool.name}</span>
												<span class="shrink-0 text-xs text-muted-foreground">${tool.group}</span>
											</div>
											<div class="truncate text-xs text-muted-foreground" title=${tool.description}>
												${tool.available ? tool.description : tool.unavailableReason ?? tool.description}
											</div>
										</div>
										<ui5-switch
											class="corp-ui5-switch"
											?checked=${workspaceToolsDraft.has(tool.name)}
											?disabled=${!tool.available}
											@change=${(e: Event) => setToolEnabled(tool.name, (e.target as HTMLInputElement & { checked: boolean }).checked)}
										></ui5-switch>
									</div>
								`)}
						</div>
					`}
			</div>
		</section>
	`;
}

function renderMcpSettings() {
	return html`
		<section class="mt-6 flex flex-col gap-3 border-t border-border pt-5">
			<div class="flex items-center justify-between gap-3">
				<div>
					<div class="text-sm font-medium">MCP tool servers</div>
					<div class="text-xs text-muted-foreground">Discovered MCP tools are exposed to the agent as separate tools.</div>
				</div>
				${Ui5Button({ children: "Add MCP", design: "Transparent", onClick: addMcpServer })}
			</div>
			${workspaceMcpServersDraft.length === 0
				? html`<div class="rounded border border-border p-3 text-xs text-muted-foreground">No MCP servers configured.</div>`
				: workspaceMcpServersDraft.map((server, index) => html`
					<div class="rounded border border-border p-3">
						<div class="mb-3 grid grid-cols-[1fr_180px_auto_auto] gap-2">
							<ui5-input class="corp-ui5-input" placeholder="Name" value=${server.name} @input=${(e: Event) => updateMcpServer(index, { name: getUi5Value(e) })}></ui5-input>
							<ui5-select class="corp-ui5-select" @change=${(e: Event) => updateMcpServer(index, { transport: getUi5Value(e) as McpServerDraft["transport"] })}>
								<ui5-option value="streamable-http" ?selected=${(server.transport ?? "streamable-http") === "streamable-http"}>Streamable HTTP</ui5-option>
								<ui5-option value="sse" ?selected=${server.transport === "sse"}>SSE</ui5-option>
								<ui5-option value="stdio" ?selected=${server.transport === "stdio"}>stdio</ui5-option>
							</ui5-select>
							<ui5-checkbox class="corp-ui5-checkbox" text="On" ?checked=${server.enabled !== false} @change=${(e: Event) => updateMcpServer(index, { enabled: (e.target as HTMLInputElement).checked })}></ui5-checkbox>
							${Ui5Button({ className: "corp-tight-icon-button", ui5Icon: "decline", title: "Remove MCP server", onClick: () => removeMcpServer(index) })}
						</div>
						${server.transport === "stdio"
							? html`
								<div class="grid grid-cols-2 gap-2">
									<ui5-input class="corp-ui5-input" placeholder="Command" value=${server.command ?? ""} @input=${(e: Event) => updateMcpServer(index, { command: getUi5Value(e) })}></ui5-input>
									<ui5-input class="corp-ui5-input" placeholder="Args, comma separated" value=${server.args?.join(", ") ?? ""} @input=${(e: Event) => updateMcpServer(index, { args: parseCsvList(getUi5Value(e)) })}></ui5-input>
								</div>
								<ui5-textarea class="corp-ui5-textarea mt-2 w-full" placeholder='Environment JSON, e.g. {"TOKEN":"..."}' rows="4" value=${server.env ? JSON.stringify(server.env, null, 2) : ""} @input=${(e: Event) => { try { updateMcpServer(index, { env: parseJsonObject(getUi5Value(e)) }); } catch { /* keep typing */ } }}></ui5-textarea>
							`
							: html`
								<ui5-input class="corp-ui5-input w-full" placeholder="MCP URL" value=${server.url ?? ""} @input=${(e: Event) => updateMcpServer(index, { url: getUi5Value(e) })}></ui5-input>
								<ui5-textarea class="corp-ui5-textarea mt-2 w-full" placeholder='Headers JSON, e.g. {"Authorization":"Bearer ..."}' rows="4" value=${server.headers ? JSON.stringify(server.headers, null, 2) : ""} @input=${(e: Event) => { try { updateMcpServer(index, { headers: parseJsonObject(getUi5Value(e)) }); } catch { /* keep typing */ } }}></ui5-textarea>
							`}
						<div class="mt-2 grid grid-cols-2 gap-2">
							<ui5-input class="corp-ui5-input" placeholder="Tool prefix" value=${server.toolPrefix ?? ""} @input=${(e: Event) => updateMcpServer(index, { toolPrefix: getUi5Value(e) })}></ui5-input>
							<ui5-input class="corp-ui5-input" type="Number" placeholder="Timeout ms" value=${server.timeoutMs ? String(server.timeoutMs) : ""} @input=${(e: Event) => updateMcpServer(index, { timeoutMs: Number(getUi5Value(e)) || undefined })}></ui5-input>
							<ui5-input class="corp-ui5-input" placeholder="Allowed tools, comma separated" value=${server.allowedTools?.join(", ") ?? ""} @input=${(e: Event) => updateMcpServer(index, { allowedTools: parseCsvList(getUi5Value(e)) })}></ui5-input>
							<ui5-input class="corp-ui5-input" placeholder="Blocked tools, comma separated" value=${server.blockedTools?.join(", ") ?? ""} @input=${(e: Event) => updateMcpServer(index, { blockedTools: parseCsvList(getUi5Value(e)) })}></ui5-input>
						</div>
					</div>
				`)}
		</section>
	`;
}

function renderWorkspaceSettingsDialog() {
	if (!workspaceSettingsDialogOpen) return "";
	if (!serviceFeatures.agentWorkers && workspaceSettingsTab === "workers") {
		workspaceSettingsTab = "agent";
	}
	if (!serviceFeatures.connection && workspaceSettingsTab === "connection") {
		workspaceSettingsTab = "agent";
	}
	if (!serviceFeatures.tools && workspaceSettingsTab === "tools") {
		workspaceSettingsTab = "agent";
	}
	const sap = workspaceSettings.sapConnection ?? {};
	const promptFile = workspaceSettings.agent?.promptFile ?? "AGENTS.md";
	const visibleTabs = 2 + (serviceFeatures.connection ? 1 : 0) + (serviceFeatures.tools ? 1 : 0) + (serviceFeatures.agentWorkers ? 1 : 0);
	const tabColumns = visibleTabs >= 5 ? "grid-cols-5" : visibleTabs === 4 ? "grid-cols-4" : visibleTabs === 3 ? "grid-cols-3" : "grid-cols-2";
	return html`
		<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4" @click=${closeWorkspaceSettingsDialog}>
			<form class="w-full max-w-2xl rounded border border-border bg-background shadow-xl" @submit=${saveWorkspaceSettings} @click=${(e: Event) => e.stopPropagation()}>
				<div class="flex items-center justify-between border-b border-border px-4 py-3">
					<div class="text-sm font-semibold">Workspace settings</div>
					${Ui5Button({ className: "corp-tight-icon-button", ui5Icon: "decline", onClick: closeWorkspaceSettingsDialog, title: "Close" })}
				</div>
				<div class="border-b border-border px-4 pt-3">
					<div class=${`grid w-full max-w-xl ${tabColumns} gap-1`}>
						<ui5-button
							class="corp-ui5-button corp-tab-button"
							design=${workspaceSettingsTab === "agent" ? "Emphasized" : "Transparent"}
							@click=${() => { workspaceSettingsTab = "agent"; renderApp(); }}
						>
							Agent
						</ui5-button>
						${serviceFeatures.connection ? html`
							<ui5-button
								class="corp-ui5-button corp-tab-button"
								design=${workspaceSettingsTab === "connection" ? "Emphasized" : "Transparent"}
								@click=${() => { workspaceSettingsTab = "connection"; if (sapConnMode === "local") { if (!sapLocalSystemsLoaded) void loadLocalSystems(); } else if (!sapDestinationsLoaded) { void loadSapDestinations(); } renderApp(); }}
							>
								Connection
							</ui5-button>
						` : ""}
						${serviceFeatures.tools ? html`
							<ui5-button
								class="corp-ui5-button corp-tab-button"
								design=${workspaceSettingsTab === "tools" ? "Emphasized" : "Transparent"}
								@click=${() => { workspaceSettingsTab = "tools"; void loadToolCatalog().then(renderApp); renderApp(); }}
							>
								Tools
							</ui5-button>
						` : ""}
						${serviceFeatures.agentWorkers ? html`
							<ui5-button
								class="corp-ui5-button corp-tab-button"
								design=${workspaceSettingsTab === "workers" ? "Emphasized" : "Transparent"}
								@click=${() => { workspaceSettingsTab = "workers"; void refreshAgentWorkers(false); renderApp(); }}
							>
								Workers
							</ui5-button>
						` : ""}
						<ui5-button
							class="corp-ui5-button corp-tab-button"
							design=${workspaceSettingsTab === "sandbox" ? "Emphasized" : "Transparent"}
							@click=${() => { workspaceSettingsTab = "sandbox"; void refreshWorkspaceSandbox(false); renderApp(); }}
						>
							Sandbox
						</ui5-button>
					</div>
				</div>
				<div class="max-h-[70vh] min-h-[58vh] overflow-y-auto p-4">
					${workspaceSettingsBusy
						? html`<div class="text-xs italic text-muted-foreground">Loading...</div>`
						: html`
							<div class="flex flex-col gap-5">
								${workspaceSettingsTab === "agent"
									? html`
										<section class="flex min-h-[52vh] flex-col gap-3">
											<div>
												<div class="text-sm font-medium">Agent instructions</div>
												<div class="text-xs text-muted-foreground">Workspace-level instructions loaded from ${promptFile}.</div>
											</div>
											<ui5-textarea
												class="corp-ui5-textarea corp-agent-instructions-editor flex-1"
												placeholder="Add workspace-specific behavior, rules, preferred tools, and project context."
												rows="18"
												value=${workspaceAgentPromptDraft}
												@input=${(e: Event) => { workspaceAgentPromptDraft = getUi5Value(e); }}
											></ui5-textarea>
										</section>
									`
									: workspaceSettingsTab === "connection"
											? html`${renderBusinessConnectorSettings(sap)}${renderMcpSettings()}`
											: workspaceSettingsTab === "tools"
											? renderToolSettings()
											: workspaceSettingsTab === "workers"
											? renderAgentWorkerSettings()
											: renderSandboxSettings()}
							</div>
						`}
					${workspaceSettingsError ? html`<div class="mt-3 text-xs text-destructive">${workspaceSettingsError}</div>` : ""}
				</div>
				<div class="flex justify-end gap-2 border-t border-border px-4 py-3">
					${Ui5Button({ children: workspaceSettingsTab === "workers" || workspaceSettingsTab === "sandbox" ? "Close" : "Cancel", onClick: closeWorkspaceSettingsDialog })}
					${workspaceSettingsTab === "workers" || workspaceSettingsTab === "sandbox"
						? ""
						: html`
							<ui5-button
								class="corp-ui5-button"
								design="Emphasized"
								?disabled=${workspaceSettingsBusy}
								@click=${saveWorkspaceSettings}
							>
								${workspaceSettingsBusy ? "Loading..." : "Save"}
							</ui5-button>
						`}
				</div>
			</form>
		</div>
	`;
}

function renderApp() {
	if (!currentUser) {
		if (ssoConfig.hideAuthUi || !authResolved) {
			render(
				html`
					<div class="w-full h-screen flex items-center justify-center bg-background text-foreground">
						<div class="text-sm text-muted-foreground">Signing in…</div>
					</div>
				`,
				app,
			);
			return;
		}
		render(
			html`
				<div class="w-full h-screen flex items-center justify-center bg-background text-foreground">
					<form class="w-full max-w-sm px-6 flex flex-col gap-3" @submit=${submitAuth}>
						<div>
							<div class="text-xl font-semibold">Core Service</div>
							<div class="text-sm text-muted-foreground">${authMode === "login" ? "Sign in to continue" : "Create your account"}</div>
						</div>
						${authMode === "register"
							? html`
								<ui5-input
									class="corp-ui5-input"
									placeholder="Display name"
									value=${authDisplayName}
									@input=${(e: Event) => { authDisplayName = getUi5Value(e); }}
								></ui5-input>
							`
							: ""}
						<ui5-input
							class="corp-ui5-input"
							type="Email"
							placeholder="Email"
							value=${authEmail}
							required
							@input=${(e: Event) => { authEmail = getUi5Value(e); }}
						></ui5-input>
						<ui5-input
							class="corp-ui5-input"
							type="Password"
							placeholder="Password"
							value=${authPassword}
							required
							@input=${(e: Event) => { authPassword = getUi5Value(e); }}
						></ui5-input>
						${authError ? html`<div class="text-xs text-destructive">${authError}</div>` : ""}
						<ui5-button class="corp-ui5-button corp-wide-button" design="Emphasized" @click=${submitAuth}>
							${authMode === "login" ? "Sign in" : "Create account"}
						</ui5-button>
						<ui5-button
							class="corp-ui5-button corp-wide-button"
							design="Transparent"
							@click=${() => { authMode = authMode === "login" ? "register" : "login"; authError = ""; renderApp(); }}
						>
							${authMode === "login" ? "Create an account" : "Use an existing account"}
						</ui5-button>
						${ssoConfig.enabled
							? html`
								<div class="flex items-center gap-2 my-1">
									<div class="h-px flex-1 bg-border"></div>
									<span class="text-xs text-muted-foreground">or</span>
									<div class="h-px flex-1 bg-border"></div>
								</div>
								${Ui5Button({
									className: "corp-wide-button",
									design: "Transparent",
									children: html`${icon(KeyRound, "xs")}<span>${`Sign in with ${ssoConfig.label ?? "SSO"}`}</span>`,
									onClick: () => { window.location.href = client.ssoLoginHref(); },
									title: "Sign in with SSO",
								})}
							`
							: ""}
					</form>
				</div>
			`,
			app,
		);
		return;
	}

	render(
		html`
			<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
				<!-- Header -->
				<div class="flex items-center justify-between border-b border-border shrink-0 px-4 py-1">
					<div class="flex items-center gap-2">
						${Ui5Button({
							className: "corp-icon-button",
							ui5Icon: sidebarOpen ? "navigation-left-arrow" : "navigation-right-arrow",
							onClick: toggleSidebar,
							title: sidebarOpen ? "Collapse sessions" : "Expand sessions",
						})}
						<span class="corp-app-title text-base font-semibold text-foreground">${serviceFeatures.appHeader}</span>
					</div>
					<div class="flex items-center gap-2">
						${Ui5Button({
							className: workspaceOpen ? "" : "corp-icon-button",
							ui5Icon: "add",
							children: workspaceOpen ? "Workspace" : "",
							onClick: () => void newWorkspace(),
							title: "New workspace",
						})}
						${!workspaceOpen
							? Ui5Button({
								ui5Icon: "folder-blank",
								children: "Workspace",
								onClick: toggleWorkspace,
								title: "Expand workspace",
							})
							: ""}
						${renderThemeMenu()}
						${renderUserMenu()}
					</div>
				</div>

				<!-- Body -->
				<div class="flex flex-1 overflow-hidden">
					<!-- Sidebar -->
					${sidebarOpen
						? html`
							<div class="w-60 shrink-0 border-r border-border flex flex-col overflow-hidden bg-background">
								<div class="p-2 shrink-0">
									${Ui5Button({
										className: "corp-wide-button",
										ui5Icon: "add",
										children: "New session",
										onClick: newSession,
										title: "New session",
									})}
								</div>
								<div class="px-2 pb-2 shrink-0">
									<ui5-input
										class="corp-ui5-input w-full"
										placeholder="Search sessions"
										show-clear-icon
										value=${sessionFilter}
										@input=${(e: Event) => { sessionFilter = getUi5Value(e); renderApp(); }}
									></ui5-input>
								</div>
								<div class="flex-1 overflow-y-auto">
									${sessions.length === 0
										? html`<div class="px-3 py-4 text-xs text-muted-foreground italic">No sessions yet</div>`
										: filteredSessions().length === 0
											? html`<div class="px-3 py-4 text-xs text-muted-foreground italic">No matching sessions</div>`
											: filteredSessions().map(
												(s) => html`
													<div class="group w-full px-3 py-2 hover:bg-accent transition-colors flex items-start gap-1 ${s.channelId === channelId ? "bg-accent" : ""}">
														<button
															class="flex-1 min-w-0 text-left flex flex-col gap-0.5"
															@click=${() => switchSession(s.channelId)}
														>
															<div class="flex items-center gap-1.5 min-w-0">
																${icon(MessageSquare, "xs")}
																<span class="text-xs font-medium truncate flex-1">${s.preview || "Empty session"}</span>
															</div>
															<div class="text-xs text-muted-foreground flex gap-2 pl-4">
																<span>${s.messageCount} msg${s.messageCount !== 1 ? "s" : ""}</span>
																<span>${formatTime(s.lastModified)}</span>
															</div>
														</button>
														<button
															class="shrink-0 opacity-0 group-hover:opacity-100 p-0.5 mt-0.5 rounded hover:bg-destructive/10 text-destructive transition-opacity [&>svg]:h-3.5 [&>svg]:w-3.5"
															title="Delete session"
															@click=${(e: Event) => { e.stopPropagation(); void deleteSession(s.channelId); }}
														>${icon(Trash2, "xs")}</button>
													</div>
												`,
											)}
								</div>
							</div>
						`
						: ""}

					<!-- Chat Panel -->
					<div class="flex-1 min-w-0 overflow-hidden flex flex-col">
						${channelId ? chatPanel : html`<div class="flex h-full items-center justify-center text-sm text-muted-foreground">Select or create a session</div>`}
					</div>

					<!-- Workspace -->
					${workspaceOpen
						? html`
							<div class="w-72 border-l border-border bg-background flex flex-col overflow-hidden">
								<div class="shrink-0 border-b border-border p-2">
									<div class="flex items-center gap-2">
										<ui5-select
											class="corp-ui5-select min-w-0 flex-1"
											@change=${(e: Event) => void switchWorkspace(getUi5SelectValue(e, workspaceId))}
										>
											${workspaces.map((w) => html`<ui5-option value=${w.id} ?selected=${w.id === workspaceId}>${w.name}</ui5-option>`)}
										</ui5-select>
										<ui5-button
											class="corp-ui5-button corp-tight-icon-button"
											design="Transparent"
											icon="refresh"
											title="Reload workspace"
											@click=${() => void loadWorkspace()}
										></ui5-button>
										${serviceFeatures.reminders
											? Ui5Button({
												className: "corp-tight-icon-button",
												ui5Icon: "bell",
												onClick: () => void openWorkspaceEventsDialog(),
												title: "Scheduled events",
											})
											: ""}
										${Ui5Button({ className: "corp-tight-icon-button", ui5Icon: "navigation-right-arrow", onClick: toggleWorkspace, title: "Collapse workspace" })}
									</div>
								</div>
								<div class="flex-1 min-h-0 flex flex-col overflow-hidden">
									<div class="shrink-0 border-b border-border p-2">
										<div class="grid grid-cols-2 gap-1">
											<ui5-button
												class="corp-ui5-button corp-tab-button"
												design=${workspaceTab === "artifacts" ? "Emphasized" : "Transparent"}
												@click=${() => { workspaceTab = "artifacts"; renderApp(); }}
											>
												Artifacts
											</ui5-button>
											<ui5-button
												class="corp-ui5-button corp-tab-button"
												design=${workspaceTab === "skills" ? "Emphasized" : "Transparent"}
												@click=${() => { workspaceTab = "skills"; renderApp(); }}
											>
												Skills
											</ui5-button>
										</div>
										${workspaceTab === "artifacts"
											? html`
												<div class="pt-2">
													<ui5-input
														class="corp-ui5-input w-full"
														placeholder="Search artifacts"
														show-clear-icon
														value=${artifactFilter}
														@input=${(e: Event) => { artifactFilter = getUi5Value(e); renderApp(); }}
													></ui5-input>
												</div>
											`
											: html`
												<div class="pt-2">
													${Ui5Button({
														className: "corp-wide-button",
														ui5Icon: "upload",
														children: "Browser Skills",
														disabled: !workspaceId || skillUploadBusy || skillUploadReading,
														onClick: () => document.getElementById("skill-folder-input")?.click(),
														title: "Upload a folder as a workspace skill",
													})}
												</div>
											`}
									</div>
									<div class="flex-1 overflow-y-auto p-2">
										${workspaceTab === "artifacts"
											? renderArtifacts()
											: html`${workspaceTree.skills.length > 0 ? renderTree(workspaceTree.skills, 0, true) : html`<div class="text-xs text-muted-foreground px-2 py-1">No skills</div>`}`}
									</div>
								</div>
								${renderAcpWorkersPanel()}
								<div class="shrink-0 border-t border-border p-2">
									${Ui5Button({
										className: "corp-wide-button",
										ui5Icon: "settings",
										children: "Settings",
										onClick: () => void openWorkspaceSettingsDialog(),
										title: "Workspace settings",
									})}
								</div>
							</div>
						`
						: ""}
				</div>
				<!-- Skill folder picker. Lives at the app root, not inside the Skills tab:
				     the chat composer's "+" menu triggers it too, with the sidebar closed. -->
				<input
					id="skill-folder-input"
					type="file"
					webkitdirectory
					multiple
					style="display: none;"
					@change=${(e: Event) => void onSkillFolderPicked(e)}
				/>
				${renderCreateWorkspaceDialog()}
				${renderSkillUploadDialog()}
				${renderProviderDialog()}
				${renderWorkspaceEventsDialog()}
				${renderWorkspaceSettingsDialog()}
			</div>
		`,
		app,
	);
}

// Initial render then load workspaces/sessions
consumeSsoHash();
void refreshSsoConfig();
renderApp();
void initializeAuth();
