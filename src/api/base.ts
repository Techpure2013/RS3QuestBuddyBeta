// API server base URL
const API_SERVER = "https://techpure.dev";

// Images server base URL
const IMAGES_SERVER = "https://techpure.dev";

export function getAppBase(): string {
	const base =
		(window as any).__APP_CONFIG__?.APP_BASE ??
		(document.querySelector("base") as HTMLBaseElement | null)?.href ??
		"/";
	return base.endsWith("/") ? base : base + "/";
}

export function getApiBase(): string {
	const override = (window as any).__APP_CONFIG__?.API_BASE;
	if (override) return override;

	// In dev: call /api (devServer proxy handles it)
	// In prod: same-origin /api behind NGINX
	return "/api";
}

export function getApiServerBase(): string {
	const override = (window as any).__APP_CONFIG__?.API_BASE;
	if (override) return override.replace(/\/api\/?$/, "");

	const host = window.location.hostname;
	if (host === "localhost" || host === "127.0.0.1") {
		return API_SERVER;
	}

	return `${window.location.origin}/api`;
}

export function getImagesBase(): string {
	// Images are served at www.techpure.dev/images/ (NGINX root-level alias).
	// In production browser, "" works because /images/ resolves from origin root.
	// In Electron or local dev, we need the full production URL.
	const host = window.location.hostname;
	const isLocal = host === "localhost" || host === "127.0.0.1";
	const isElectron = !!(window as any).alt1gl || !!(window as any)._alt1gl;
	return (isElectron || isLocal) ? "https://www.techpure.dev" : "";
}

export function getEditorBaseUrl(): string {
	const cfg = (window as any).__APP_CONFIG__;
	if (cfg?.EDITOR_BASE_URL) {
		const url = cfg.EDITOR_BASE_URL;
		return url.endsWith("/") ? url : url + "/";
	}

	const host = window.location.hostname;
	if (host === "localhost" || host === "127.0.0.1") {
		return "http://127.0.0.1:3000/RS3QuestBuddyEditor/";
	}

	return "https://techpure.dev/RS3QuestBuddyEditor/";
}
