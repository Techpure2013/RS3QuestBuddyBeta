import { getApiBase } from "./base";

export async function fetchAllQuestsFull() {
	const api = getApiBase();
	const r = await fetch(`${api}/quests/all-full`);
	if (!r.ok) throw new Error("all-full failed");
	const json = await r.json();
	return json.items as Array<{
		id: number;
		total_steps: number;
		quest_name: string;
		quest_series: string;
		quest_age: string;
		quest_release_date: string | null;
		quest_points: number;
		quest_rewards: string[];
		created_at: string;
		updated_at: string;
	}>;
}

export async function fetchQuestBundleByName(name: string) {
	const api = getApiBase();
	const r = await fetch(
		`${api}/quests/${encodeURIComponent(name)}/bundle`,
	);
	if (!r.ok) throw new Error("bundle failed");
	return r.json();
}
