import type { RunMetrics, Split } from "./garmin/analysis";
import type { Lap } from "./garmin/fit";
import { type ActivityRow, DAILY_HEALTH_COLUMNS, type DailyHealthRow } from "./garmin/mapping";

export type User = {
	id: number;
	github_login: string;
	display_name: string | null;
	health_backfilled_to: string | null;
	last_sync_at: string | null;
	last_sync_error: string | null;
};

export async function findUserByLogin(db: D1Database, login: string): Promise<User | null> {
	return db.prepare("SELECT * FROM users WHERE github_login = ?").bind(login).first<User>();
}

/** Legt den Nutzer an, falls er fehlt, und gibt ihn zurück. */
export async function ensureUser(db: D1Database, login: string, displayName?: string | null): Promise<User> {
	await db
		.prepare(
			`INSERT INTO users (github_login, display_name) VALUES (?, ?)
			 ON CONFLICT(github_login) DO UPDATE SET display_name = COALESCE(excluded.display_name, users.display_name)`,
		)
		.bind(login, displayName ?? null)
		.run();
	const user = await findUserByLogin(db, login);
	if (!user) throw new Error(`Nutzer ${login} konnte nicht angelegt werden`);
	return user;
}

const ACTIVITY_COLUMNS = [
	"name",
	"type_key",
	"start_time_local",
	"start_time_gmt",
	"duration_s",
	"moving_duration_s",
	"distance_m",
	"elevation_gain_m",
	"elevation_loss_m",
	"avg_speed_mps",
	"max_speed_mps",
	"avg_hr",
	"max_hr",
	"calories",
	"avg_power",
	"norm_power",
	"avg_cadence",
	"aerobic_te",
	"anaerobic_te",
	"training_load",
	"vo2max",
	"hr_zones_s",
	"lap_count",
	"summary_json",
] as const satisfies readonly (keyof ActivityRow)[];

export function upsertActivities(db: D1Database, userId: number, rows: ActivityRow[]) {
	const cols = ["user_id", "activity_id", ...ACTIVITY_COLUMNS];
	const sql = `INSERT INTO activities (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})
		ON CONFLICT(user_id, activity_id) DO UPDATE SET
		${ACTIVITY_COLUMNS.map((c) => `${c} = excluded.${c}`).join(", ")}, updated_at = datetime('now')`;
	const stmt = db.prepare(sql);
	return db.batch(rows.map((r) => stmt.bind(userId, r.activity_id, ...ACTIVITY_COLUMNS.map((c) => r[c]))));
}

/** Fehlende Werte überschreiben vorhandene nicht (z. B. Schlaf, der erst später kommt). */
export function upsertDailyHealth(db: D1Database, userId: number, rows: DailyHealthRow[]) {
	const cols = ["user_id", "date", ...DAILY_HEALTH_COLUMNS];
	const sql = `INSERT INTO daily_health (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})
		ON CONFLICT(user_id, date) DO UPDATE SET
		${DAILY_HEALTH_COLUMNS.map((c) => `${c} = COALESCE(excluded.${c}, daily_health.${c})`).join(", ")},
		updated_at = datetime('now')`;
	const stmt = db.prepare(sql);
	return db.batch(rows.map((r) => stmt.bind(userId, r.date, ...DAILY_HEALTH_COLUMNS.map((c) => r[c] ?? null))));
}

const LAP_COLUMNS = [
	"lap_index",
	"start_time",
	"elapsed_s",
	"timer_s",
	"distance_m",
	"avg_speed_mps",
	"max_speed_mps",
	"avg_hr",
	"max_hr",
	"avg_cadence",
	"avg_power",
	"ascent_m",
	"descent_m",
	"calories",
	"lap_trigger",
] as const satisfies readonly (keyof Lap)[];

const SPLIT_COLUMNS = ["km", "distance_m", "time_s", "avg_hr", "ascent_m", "descent_m"] as const satisfies readonly (keyof Split)[];

/**
 * Speichert alles, was aus einer FIT-Datei gelesen wurde, in einer Transaktion:
 * Runden, bei Läufen Kennzahlen, Splits und HF-Stufen, und vermerkt die Datei an der Aktivität.
 */
export function saveFitResults(
	db: D1Database,
	userId: number,
	activityId: number,
	fitKey: string,
	laps: Lap[],
	metrics: RunMetrics | null,
) {
	const ids = [userId, activityId] as const;
	const lapCols = ["user_id", "activity_id", ...LAP_COLUMNS];
	const insertLap = db.prepare(`INSERT INTO laps (${lapCols.join(", ")}) VALUES (${lapCols.map(() => "?").join(", ")})`);
	const statements = [
		db.prepare("DELETE FROM laps WHERE user_id = ? AND activity_id = ?").bind(...ids),
		...laps.map((l) => insertLap.bind(...ids, ...LAP_COLUMNS.map((c) => l[c]))),
		db
			.prepare(
				`UPDATE activities SET fit_r2_key = ?, fit_error = NULL, fit_attempts = 0,
				 lap_count = COALESCE(lap_count, ?), updated_at = datetime('now')
				 WHERE user_id = ? AND activity_id = ?`,
			)
			.bind(fitKey, laps.length, ...ids),
	];
	if (metrics) {
		const json = (v: unknown) => (v === null ? null : JSON.stringify(v));
		const splitCols = ["user_id", "activity_id", ...SPLIT_COLUMNS];
		const insertSplit = db.prepare(
			`INSERT INTO activity_splits (${splitCols.join(", ")}) VALUES (${splitCols.map(() => "?").join(", ")})`,
		);
		const insertBin = db.prepare(
			"INSERT INTO activity_hr_bins (user_id, activity_id, bpm_low, seconds, meters) VALUES (?, ?, ?, ?, ?)",
		);
		statements.push(
			db.prepare("DELETE FROM activity_splits WHERE user_id = ? AND activity_id = ?").bind(...ids),
			db.prepare("DELETE FROM activity_hr_bins WHERE user_id = ? AND activity_id = ?").bind(...ids),
			...metrics.splits.map((s) => insertSplit.bind(...ids, ...SPLIT_COLUMNS.map((c) => s[c]))),
			...metrics.hr_bins.map((b) => insertBin.bind(...ids, b.bpm_low, b.seconds, b.meters)),
			db
				.prepare(
					`INSERT OR REPLACE INTO activity_metrics
					 (user_id, activity_id, metrics_version, moving_s, distance_m, zone_bounds, zone_calc, zone_s,
					  zone_moving_s, zone_m, hr_drift_pct, pace_cv_pct, error, computed_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, datetime('now'))`,
				)
				.bind(
					...ids,
					metrics.metrics_version,
					metrics.moving_s,
					metrics.distance_m,
					json(metrics.zone_bounds),
					metrics.zone_calc,
					json(metrics.zone_s),
					json(metrics.zone_moving_s),
					json(metrics.zone_m),
					metrics.hr_drift_pct,
					metrics.pace_cv_pct,
				),
		);
	}
	return db.batch(statements);
}

/** Zählt einen Verarbeitungsversuch hoch, bevor die CPU-intensive Arbeit beginnt. */
export async function startFitAttempt(db: D1Database, userId: number, activityId: number): Promise<number> {
	const row = await db
		.prepare(
			"UPDATE activities SET fit_attempts = fit_attempts + 1 WHERE user_id = ? AND activity_id = ? RETURNING fit_attempts",
		)
		.bind(userId, activityId)
		.first<{ fit_attempts: number }>();
	return row?.fit_attempts ?? 0;
}

export function markFitError(db: D1Database, userId: number, activityId: number, error: string) {
	return db
		.prepare("UPDATE activities SET fit_error = ?, updated_at = datetime('now') WHERE user_id = ? AND activity_id = ?")
		.bind(error.slice(0, 500), userId, activityId)
		.run();
}
