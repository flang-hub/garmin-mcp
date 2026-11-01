import { addDays, localDate, maxDate } from "./dates";
import { upsertActivities, upsertDailyHealth, type User } from "./db";
import { isRun, pendingFileWork, processActivityFile } from "./files";
import { GarminApiError, type GarminClient } from "./garmin/client";
import { mergeDailyHealth, toActivityRow } from "./garmin/mapping";
import { garminUsers } from "./sync";

/**
 * Historien-Backfill, läuft im eigenen Cron (alle 10 Minuten) in kleinen Paketen.
 * Fortschritt steht in backfill_jobs, daher jederzeit wiederaufnehmbar.
 *
 * - activities: Läufe in Monatsfenstern rückwärts bis zum Ziel
 * - health:     Tageswerte in 28-Tage-Fenstern (Garmin erlaubt beim Schlaf höchstens 31 Tage)
 * - files:      FIT-Dateien und Kennzahlen, eine Datei pro Aufruf (CPU-Limit Workers Free)
 */

export type JobName = "activities" | "health" | "files";

export type Job = {
	job: JobName;
	cursor: string | null;
	target: string;
	done: number;
	processed: number;
	failures: number;
	last_run_at: string | null;
	last_error: string | null;
	retry_after: string | null;
};

const MONTHS_PER_RUN = 2;
const HEALTH_WINDOW_DAYS = 28;
const HEALTH_WINDOWS_PER_RUN = 2;
const PAGE_SIZE = 100;
// Pause zwischen Garmin-Aufrufen; Garmin veröffentlicht keine Rate-Limits.
const PAUSE_MS = 1000;
const MAX_BACKOFF_MIN = 12 * 60;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function addMonths(date: string, months: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	const day = d.getUTCDate();
	d.setUTCDate(1);
	d.setUTCMonth(d.getUTCMonth() + months);
	const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
	d.setUTCDate(Math.min(day, last));
	return d.toISOString().slice(0, 10);
}

/** Wartezeit nach dem n-ten Fehler in Folge: 30 min, 1 h, 2 h … höchstens 12 h. */
export function backoffMinutes(failures: number): number {
	return Math.min(30 * 2 ** Math.max(0, failures - 1), MAX_BACKOFF_MIN);
}

export function backfillTarget(env: Env, today: string): string {
	return addMonths(today, -Number(env.BACKFILL_MONTHS || 24));
}

/** Legt die Jobs an und passt das Ziel an, wenn BACKFILL_MONTHS geändert wurde. */
export async function ensureJobs(db: D1Database, userId: number, target: string): Promise<Map<JobName, Job>> {
	const jobs: JobName[] = ["activities", "health", "files"];
	await db.batch(
		jobs.map((job) =>
			db
				.prepare(
					`INSERT INTO backfill_jobs (user_id, job, target) VALUES (?1, ?2, ?3)
					 ON CONFLICT(user_id, job) DO UPDATE SET target = ?3,
					   done = CASE WHEN ?3 < backfill_jobs.target THEN 0 ELSE backfill_jobs.done END`,
				)
				.bind(userId, job, target),
		),
	);
	const { results } = await db.prepare("SELECT * FROM backfill_jobs WHERE user_id = ?").bind(userId).all<Job>();
	return new Map(results.map((j) => [j.job, j]));
}

async function updateJob(db: D1Database, userId: number, job: JobName, fields: Partial<Job>) {
	const entries = Object.entries({ ...fields, last_run_at: new Date().toISOString() });
	await db
		.prepare(`UPDATE backfill_jobs SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE user_id = ? AND job = ?`)
		.bind(...entries.map(([, v]) => v ?? null), userId, job)
		.run();
}

const isTransient = (err: unknown) => err instanceof GarminApiError && (err.status === 429 || err.status >= 500);

/** Führt einen Job-Schritt aus und kümmert sich um Fortschritt, Fehler und Pausen. */
async function step(
	db: D1Database,
	userId: number,
	job: Job | undefined,
	now: Date,
	run: (job: Job) => Promise<Partial<Job>>,
): Promise<"ok" | "skipped" | "transient"> {
	if (!job || job.done) return "skipped";
	if (job.retry_after && job.retry_after > now.toISOString()) return "skipped";
	try {
		const fields = await run(job);
		await updateJob(db, userId, job.job, { ...fields, failures: 0, last_error: null, retry_after: null });
		return "ok";
	} catch (err) {
		const failures = job.failures + 1;
		const retry = new Date(now.getTime() + backoffMinutes(failures) * 60_000).toISOString();
		const message = err instanceof Error ? err.message : String(err);
		await updateJob(db, userId, job.job, { failures, last_error: message.slice(0, 500), retry_after: retry });
		console.error(JSON.stringify({ event: "backfill_error", userId, job: job.job, failures, error: message }));
		return isTransient(err) ? "transient" : "ok";
	}
}

/** Läufe in Monatsfenstern rückwärts; nur Läufe werden gespeichert. */
async function activitiesStep(db: D1Database, userId: number, client: GarminClient, job: Job, today: string) {
	let cursor = job.cursor ?? addDays(today, 1);
	let processed = job.processed;
	for (let m = 0; m < MONTHS_PER_RUN && cursor > job.target; m++) {
		const end = addDays(cursor, -1);
		const start = maxDate(addMonths(cursor, -1), job.target);
		for (let page = 0; ; page++) {
			const list = (await client.searchActivities({ start: page * PAGE_SIZE, limit: PAGE_SIZE, startDate: start, endDate: end })) ?? [];
			const rows = list.filter((a) => isRun((a.activityType as { typeKey?: unknown } | undefined)?.typeKey)).map(toActivityRow).filter((r) => r !== null);
			if (rows.length) await upsertActivities(db, userId, rows);
			processed += rows.length;
			await pause(PAUSE_MS);
			if (list.length < PAGE_SIZE) break;
		}
		cursor = start;
	}
	return { cursor, processed, done: cursor <= job.target ? 1 : 0 };
}

/** Tageswerte in 28-Tage-Fenstern rückwärts; vollständige Fenster werden übersprungen. */
async function healthStep(db: D1Database, userId: number, client: GarminClient, job: Job, today: string) {
	let cursor = job.cursor ?? addDays(today, 1);
	let processed = job.processed;
	for (let w = 0; w < HEALTH_WINDOWS_PER_RUN && cursor > job.target; w++) {
		const end = addDays(cursor, -1);
		const start = maxDate(addDays(cursor, -HEALTH_WINDOW_DAYS), job.target);
		const days = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
		const have = await db
			.prepare(
				`SELECT count(*) AS n FROM daily_health
				 WHERE user_id = ? AND date BETWEEN ? AND ? AND steps IS NOT NULL AND sleep_s IS NOT NULL`,
			)
			.bind(userId, start, end)
			.first<{ n: number }>();
		if ((have?.n ?? 0) < days) {
			const [summaries, sleep, hrv] = [
				await client.dailySummaries(start, end),
				await client.sleepSummaries(start, end),
				await client.hrvSummaries(start, end),
			];
			const rows = mergeDailyHealth({ summaries, sleep, hrv });
			if (rows.length) await upsertDailyHealth(db, userId, rows);
			processed += rows.length;
			await pause(PAUSE_MS);
		}
		cursor = start;
	}
	return { cursor, processed, done: cursor <= job.target ? 1 : 0 };
}

// Länger als ein Lauf dauern darf, kürzer als der Cron-Abstand von 10 Minuten.
const LEASE_MS = 9 * 60_000;

/** Reserviert den Backfill für diesen Nutzer atomar; false, wenn schon ein Lauf aktiv ist. */
async function acquireLease(db: D1Database, userId: number, now: Date): Promise<boolean> {
	const row = await db
		.prepare(
			`UPDATE users SET backfill_lease_until = ?1
			 WHERE id = ?2 AND (backfill_lease_until IS NULL OR backfill_lease_until < ?3)
			 RETURNING id`,
		)
		.bind(new Date(now.getTime() + LEASE_MS).toISOString(), userId, now.toISOString())
		.first();
	return row !== null;
}

export async function runBackfill(env: Env, now = new Date()): Promise<void> {
	const today = localDate(env.TIMEZONE, now);
	for (const { user, client } of await garminUsers(env)) {
		if (!(await acquireLease(env.DB, user.id, now))) {
			console.log(JSON.stringify({ event: "backfill_busy", userId: user.id }));
			continue;
		}
		try {
			await backfillUser(env, user, client, today, now);
		} finally {
			await env.DB.prepare("UPDATE users SET backfill_lease_until = NULL WHERE id = ?").bind(user.id).run();
		}
	}
}

export async function backfillUser(env: Env, user: User, client: GarminClient, today: string, now: Date) {
	const jobs = await ensureJobs(env.DB, user.id, backfillTarget(env, today));
	const result: Record<string, string> = {};

	result.activities = await step(env.DB, user.id, jobs.get("activities"), now, (j) =>
		activitiesStep(env.DB, user.id, client, j, today),
	);
	if (result.activities !== "transient") {
		result.health = await step(env.DB, user.id, jobs.get("health"), now, (j) =>
			healthStep(env.DB, user.id, client, j, today),
		);
	}
	// Höchstens eine Datei pro Aufruf: Dekodieren ist der teure Teil.
	if (result.activities !== "transient" && result.health !== "transient") {
		const files = jobs.get("files");
		if (files) files.done = 0;
		result.files = await step(env.DB, user.id, files, now, async (j) => {
			const [work] = await pendingFileWork(env.DB, user.id, 1);
			if (!work) return { processed: j.processed };
			const outcome = await processActivityFile(env, user.id, work, client);
			return { processed: j.processed + (outcome === "done" ? 1 : 0) };
		});
	}
	console.log(JSON.stringify({ event: "backfill", userId: user.id, ...result }));
	return result;
}
