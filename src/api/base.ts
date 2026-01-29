// Detect if running in Electron with file:// protocol
export const isElectron = typeof window !== "undefined" && window.location.protocol === "file:";

// API server base URL
const API_SERVER = "http://127.0.0.1:42069";

// Images server base URL  
const IMAGES_SERVER = "https://techpure.dev";

export function getAppBase(): string {
	// If you set APP_BASE in __APP_CONFIG__ (e.g., "/RS3QuestBuddy/")
	const base =
		(window as any).__APP_CONFIG__?.APP_BASE ??
		(document.querySelector("base") as HTMLBaseElement | null)?.href ??
		"/";
	return base.endsWith("/") ? base : base + "/";
}

export function getApiBase(): string {
	// Check for runtime override
	const override = (window as any).__APP_CONFIG__?.API_BASE;
	if (override) return override;
	
	// In Electron with file:// protocol, use the full API URL
	if (isElectron) {
		return `${API_SERVER}/api`;
	}
	// In dev: call /api (devServer proxy handles it)
	// In prod: same-origin /api behind NGINX
	return "/api";
}

export function getApiServerBase(): string {
	// Returns the full server URL without /api suffix
	// Used for direct server connections (e.g., WebSocket)
	const override = (window as any).__APP_CONFIG__?.API_BASE;
	if (override) return override.replace(/\/api\/?$/, "");
	
	if (isElectron) {
		return API_SERVER;
	}
	
	const host = window.location.hostname;
	if (host === "localhost" || host === "127.0.0.1") {
		return API_SERVER;
	}
	
	return `${window.location.origin}/api`;
}

export function getImagesBase(): string {
	// In Electron, use full URL for images
	if (isElectron) {
		return IMAGES_SERVER;
	}
	// In web, images are served from same origin or proxied
	return "";
}

export function getEditorBaseUrl(): string {
	const cfg = (window as any).__APP_CONFIG__;
	if (cfg?.EDITOR_BASE_URL) {
		const url = cfg.EDITOR_BASE_URL;
		return url.endsWith("/") ? url : url + "/";
	}
	
	if (isElectron) {
		return "http://127.0.0.1:3000/RS3QuestBuddyEditor/";
	}
	
	const host = window.location.hostname;
	if (host === "localhost" || host === "127.0.0.1") {
		return "http://127.0.0.1:3000/RS3QuestBuddyEditor/";
	}
	
	return "https://techpure.dev/RS3QuestBuddyEditor/";
}
