import { addDays, localDate, maxDate } from "./dates";
import { ensureUser, upsertActivities, upsertDailyHealth, type User } from "./db";
import { pendingFileWork, processActivityFile } from "./files";
import { GarminClient, type TokenCache } from "./garmin/client";
import { mergeDailyHealth, toActivityRow } from "./garmin/mapping";

const PAGE_SIZE = 50;
const MAX_PAGES = 4;
// Tageswerte werden rückwärts in Blöcken dieser Größe nachgeladen.
const BACKFILL_CHUNK_DAYS = 7;

/** Token-Cache im KV, pro Nutzer, mit Ablauf passend zum Token. */
function kvTokenCache(kv: KVNamespace, userId: number): TokenCache {
	const key = `garmin-token:${userId}`;
	return {
		get: () => kv.get(key, "json"),
		put: (token) =>
			kv.put(key, JSON.stringify(token), {
				expirationTtl: Math.max(60, Math.floor(token.expiresAt - Date.now() / 1000)),
			}),
	};
}

/**
 * Phase 1: Es gibt genau einen Garmin-Schlüssel (Secret GARMIN_API_KEY), der dem
 * Nutzer GARMIN_OWNER_LOGIN gehört. Für mehrere Nutzer wird das später erweitert.
 */
function garminKeyFor(env: Env, user: User): string | null {
	return user.github_login === env.GARMIN_OWNER_LOGIN ? env.GARMIN_API_KEY || null : null;
}

/** Alle Nutzer mit Garmin-Zugang samt fertigem Client. */
export async function garminUsers(env: Env): Promise<{ user: User; client: GarminClient }[]> {
	const owner = await ensureUser(env.DB, env.GARMIN_OWNER_LOGIN);
	const out = [];
	for (const user of [owner]) {
		const apiKey = garminKeyFor(env, user);
		if (!apiKey) continue;
		const cache = kvTokenCache(env.OAUTH_KV, user.id);
		out.push({ user, client: new GarminClient(apiKey, cache, undefined, undefined, env.GARMIN_BASE_URL || undefined) });
	}
	return out;
}

export async function runScheduledSync(env: Env): Promise<void> {
	for (const { user, client } of await garminUsers(env)) {
		try {
			const result = await syncUser(env, user, client);
			await env.DB.prepare("UPDATE users SET last_sync_at = ?, last_sync_error = NULL WHERE id = ?")
				.bind(new Date().toISOString(), user.id)
				.run();
			console.log(JSON.stringify({ event: "sync_ok", userId: user.id, ...result }));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await env.DB.prepare("UPDATE users SET last_sync_error = ? WHERE id = ?").bind(message.slice(0, 500), user.id).run();
			console.error(JSON.stringify({ event: "sync_failed", userId: user.id, error: message }));
		}
	}
}

export async function syncUser(env: Env, user: User, client: GarminClient) {
	const today = localDate(env.TIMEZONE);
	const backfillStart = addDays(today, -Number(env.BACKFILL_DAYS || 30));

	const activities = await syncActivities(env.DB, user.id, client, backfillStart, today);
	const days = await syncDailyHealth(env.DB, user, client, backfillStart, today);
	const fits = await syncFitFiles(env, user.id, client, Number(env.FIT_PER_RUN || 1));
	return { activities, days, fits };
}

async function syncActivities(db: D1Database, userId: number, client: GarminClient, backfillStart: string, today: string) {
	// Ab einen Tag vor der neuesten gespeicherten Aktivität, sonst ab Beginn des Verlaufs.
	const latest = await db
		.prepare("SELECT max(substr(start_time_local, 1, 10)) AS d FROM activities WHERE user_id = ?")
		.bind(userId)
		.first<{ d: string | null }>();
	const startDate = latest?.d ? maxDate(addDays(latest.d, -1), backfillStart) : backfillStart;

	let count = 0;
	for (let page = 0; page < MAX_PAGES; page++) {
		const list =
			(await client.searchActivities({ start: page * PAGE_SIZE, limit: PAGE_SIZE, startDate, endDate: today })) ?? [];
		const rows = list.map(toActivityRow).filter((r) => r !== null);
		if (rows.length) await upsertActivities(db, userId, rows);
		count += rows.length;
		if (list.length < PAGE_SIZE) break;
	}
	return count;
}

async function fetchHealthRange(client: GarminClient, start: string, end: string) {
	const [summaries, sleep, hrv] = await Promise.all([
		client.dailySummaries(start, end),
		client.sleepSummaries(start, end),
		client.hrvSummaries(start, end),
	]);
	return mergeDailyHealth({ summaries, sleep, hrv });
}

async function syncDailyHealth(db: D1Database, user: User, client: GarminClient, backfillStart: string, today: string) {
	// Die letzten Tage immer neu holen: Werte von heute ändern sich, Schlaf kommt nachträglich.
	const recentStart = addDays(today, -2);
	const rows = await fetchHealthRange(client, recentStart, today);

	// Danach ein Stück Verlauf rückwärts, bis backfillStart erreicht ist.
	const cursor = user.health_backfilled_to ?? recentStart;
	let newCursor = cursor;
	if (cursor > backfillStart) {
		newCursor = maxDate(addDays(cursor, -BACKFILL_CHUNK_DAYS), backfillStart);
		rows.push(...(await fetchHealthRange(client, newCursor, addDays(cursor, -1))));
	}

	if (rows.length) await upsertDailyHealth(db, user.id, rows);
	if (newCursor !== user.health_backfilled_to) {
		await db.prepare("UPDATE users SET health_backfilled_to = ? WHERE id = ?").bind(newCursor, user.id).run();
	}
	return rows.length;
}

async function syncFitFiles(env: Env, userId: number, client: GarminClient, limit: number) {
	let done = 0;
	for (const work of await pendingFileWork(env.DB, userId, limit)) {
		if ((await processActivityFile(env, userId, work, client)) === "done") done++;
	}
	return done;
}
