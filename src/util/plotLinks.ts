// RS3QuestBuddy app: src/util/plotLinks.ts
import { getApiServerBase, getEditorBaseUrl } from "../api/base";

const mem = new Map<string, number>(); // cache quest|step -> stepId

export async function resolveStepId(
	questName: string,
	oneBasedStep: number,
): Promise<number | null> {
	const key = `${questName.toLowerCase()}|${oneBasedStep}`;
	if (mem.has(key)) return mem.get(key)!;

	const base = getApiServerBase();
	const qs = new URLSearchParams({
		questName,
		stepNumber: String(oneBasedStep),
	});
	// Use /api/steps/resolve path (server exposes this)
	const res = await fetch(`${base}/api/steps/resolve?${qs.toString()}`, {
		method: "GET",
		credentials: "omit",
		cache: "no-store",
		headers: { "Cache-Control": "no-store" },
	});
	if (!res.ok) return null;
	const json = (await res.json()) as { ok: boolean; stepId?: number };
	const id = json.ok && typeof json.stepId === "number" ? json.stepId : null;
	if (id) mem.set(key, id);
	return id;
}

// Build a plot link that may include ?stepId=<id> if resolve succeeds.
// Do not re-append ?stepId at call sites.
export async function buildPlotLinkAsync(
	questName: string,
	stepIndex: number,
): Promise<string> {
	const base = getEditorBaseUrl();
	const oneBased = stepIndex + 1;
	const stepId = await resolveStepId(questName, oneBased).catch(() => null);
	const qp = stepId && stepId > 0 ? `?stepId=${stepId}` : "";
	return `${base}plot/${encodeURIComponent(questName)}/${oneBased}${qp}`;
}

// Synchronous fallback (no stepId)
export function buildPlotLink(questName: string, stepIndex: number): string {
	const base = getEditorBaseUrl();
	return `${base}plot/${encodeURIComponent(questName)}/${stepIndex + 1}`;
}

// Re-export for backwards compatibility
export { getEditorBaseUrl };
