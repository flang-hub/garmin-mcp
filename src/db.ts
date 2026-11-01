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

/** Speichert Runden und vermerkt die FIT-Datei an der Aktivität, alles in einer Transaktion. */
export function saveLaps(db: D1Database, userId: number, activityId: number, laps: Lap[], fitKey: string) {
	const cols = ["user_id", "activity_id", ...LAP_COLUMNS];
	const insert = db.prepare(`INSERT INTO laps (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
	return db.batch([
		db.prepare("DELETE FROM laps WHERE user_id = ? AND activity_id = ?").bind(userId, activityId),
		...laps.map((l) => insert.bind(userId, activityId, ...LAP_COLUMNS.map((c) => l[c]))),
		db
			.prepare(
				`UPDATE activities SET fit_r2_key = ?, fit_error = NULL, lap_count = COALESCE(lap_count, ?), updated_at = datetime('now')
				 WHERE user_id = ? AND activity_id = ?`,
			)
			.bind(fitKey, laps.length, userId, activityId),
	]);
}

export function markFitError(db: D1Database, userId: number, activityId: number, error: string) {
	return db
		.prepare("UPDATE activities SET fit_error = ?, updated_at = datetime('now') WHERE user_id = ? AND activity_id = ?")
		.bind(error.slice(0, 500), userId, activityId)
		.run();
}
