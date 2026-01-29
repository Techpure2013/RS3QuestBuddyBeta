import { bundleToQuest, type Quest, type QuestBundle } from "./../state/types";
import { getApiBase } from "../api/base";

const cache = new Map<string, Quest>(); // key: questName (trimmed)

export function getCachedQuest(name: string): Quest | null {
	const key = name.trim();
	return cache.get(key) ?? null;
}

export function setCachedQuest(name: string, quest: Quest) {
	cache.set(name.trim(), quest);
}

export async function fetchQuestBundleNormalized(name: string): Promise<Quest> {
	const key = name.trim();
	const hit = cache.get(key);
	if (hit) return hit;

	const api = getApiBase();
	const res = await fetch(
		`${api}/quests/${encodeURIComponent(key)}/bundle`,
		{ credentials: "same-origin" },
	);
	if (!res.ok) {
		throw new Error(`bundle fetch failed: ${res.status} ${res.statusText}`);
	}
	const bundle = (await res.json()) as QuestBundle;
	const quest = bundleToQuest(bundle);
	cache.set(key, quest);
	return quest;
}
