import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { addDays, localDate } from "./dates";
import { activityDetail, activitySummary, dailyAverages, dailyHealth } from "./format";
import { syncStatus, TREND_METRICS, trend, weeklySummary } from "./trends";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Format YYYY-MM-DD");

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

/** Registriert die Garmin-Werkzeuge; jede Abfrage ist auf die user_id des angemeldeten Nutzers beschränkt. */
export function registerGarminTools(server: McpServer, env: Env, userId: number) {
	const db = env.DB;

	server.registerTool(
		"get_recent_activities",
		{
			description:
				"Listet die letzten Garmin-Aktivitäten mit kompakten Kennzahlen (Distanz, Dauer, Pace bzw. Tempo, Puls, Trainingslast). " +
				"Nutze die activity_id für get_activity_detail.",
			inputSchema: z.object({
				days: z.number().int().min(1).max(365).default(14).describe("Zeitraum in Tagen bis heute"),
				type: z
					.string()
					.optional()
					.describe("Filter auf den Garmin-Typ, z. B. running, cycling, swimming (Teilstring genügt)"),
				limit: z.number().int().min(1).max(50).default(20),
			}),
		},
		async ({ days, type, limit }) => {
			const since = addDays(localDate(env.TIMEZONE), -days);
			const { results } = await db
				.prepare(
					`SELECT * FROM activities
					 WHERE user_id = ?1 AND start_time_local >= ?2 AND (?3 IS NULL OR type_key LIKE '%' || ?3 || '%')
					 ORDER BY start_time_gmt DESC LIMIT ?4`,
				)
				.bind(userId, since, type ?? null, limit)
				.all();
			const sync = await syncNote(db, userId);
			return json({ since, count: results.length, activities: results.map(activitySummary), ...sync });
		},
	);

	server.registerTool(
		"get_activity_detail",
		{
			description:
				"Details einer Aktivität: Kennzahlen, Minuten pro Herzfrequenzzone, Runden und bei Läufen " +
				"Kilometer-Splits, Pace pro Zone, HF-Drift und Pace-Streuung (aus der FIT-Datei).",
			inputSchema: z.object({ activity_id: z.number().int().describe("ID aus get_recent_activities") }),
		},
		async ({ activity_id }) => {
			const ids = [userId, activity_id] as const;
			const [activity, laps, metrics, splits] = await Promise.all([
				db.prepare("SELECT * FROM activities WHERE user_id = ? AND activity_id = ?").bind(...ids).first(),
				db.prepare("SELECT * FROM laps WHERE user_id = ? AND activity_id = ? ORDER BY lap_index").bind(...ids).all(),
				db.prepare("SELECT * FROM activity_metrics WHERE user_id = ? AND activity_id = ?").bind(...ids).first(),
				db.prepare("SELECT * FROM activity_splits WHERE user_id = ? AND activity_id = ? ORDER BY km").bind(...ids).all(),
			]);
			if (!activity) return { ...json({ error: `Aktivität ${activity_id} nicht gefunden` }), isError: true };
			return json(activityDetail(activity, laps.results, metrics, splits.results));
		},
	);

	server.registerTool(
		"get_weekly_summary",
		{
			description:
				"Wochenübersicht (Mo–So) der Läufe: Kilometer, Einheiten, Zeit, Ø-Pace, längster Lauf, Trainingslast, " +
				"Minuten pro HF-Zone 1–5 und Erholungsmittel (Ruhepuls, HRV, Schlaf, Body Battery, Stress).",
			inputSchema: z.object({
				weeks: z.number().int().min(1).max(52).default(4).describe("Anzahl Wochen bis einschließlich der aktuellen"),
				end_date: DATE.optional().describe("Letzter Tag (YYYY-MM-DD); Standard: heute"),
			}),
		},
		async ({ weeks, end_date }) => {
			const end = end_date ?? localDate(env.TIMEZONE);
			const start = addDays(end, -(weeks - 1) * 7);
			return json({ weeks: await weeklySummary(db, userId, start, end) });
		},
	);

	server.registerTool(
		"get_trend",
		{
			description:
				"Verlauf einer Kennzahl pro Woche (Mo–So) mit Vergleich erste/letzte 4 Wochen. Kennzahlen: " +
				"pace_zone (Pace in HF-Zone, Parameter zone; Garmin-Zonen des jeweiligen Laufs), " +
				"pace_hr (Pace bei HF hr_min–hr_max), hr_drift, weekly_km, long_run_km, runs, " +
				"resting_hr, hrv_ms, sleep_h, sleep_score, body_battery_max, stress_avg.",
			inputSchema: z.object({
				metric: z.enum(TREND_METRICS),
				start_date: DATE.optional().describe("Erster Tag (YYYY-MM-DD); Standard: vor 12 Wochen"),
				end_date: DATE.optional().describe("Letzter Tag (YYYY-MM-DD); Standard: heute"),
				zone: z.number().int().min(1).max(5).optional().describe("Für pace_zone; Standard 2"),
				hr_min: z.number().int().min(60).max(220).optional().describe("Für pace_hr, z. B. 140"),
				hr_max: z.number().int().min(60).max(220).optional().describe("Für pace_hr, z. B. 150"),
			}),
		},
		async ({ metric, start_date, end_date, zone, hr_min, hr_max }) => {
			const end = end_date ?? localDate(env.TIMEZONE);
			const start = start_date ?? addDays(end, -12 * 7 + 1);
			if (start > end) return { ...json({ error: "start_date liegt nach end_date" }), isError: true };
			try {
				return json(await trend(db, userId, metric, start, end, { zone, hr_min, hr_max }));
			} catch (err) {
				return { ...json({ error: err instanceof Error ? err.message : String(err) }), isError: true };
			}
		},
	);

	server.registerTool(
		"get_sync_status",
		{
			description:
				"Stand des Abgleichs mit Garmin und des Historien-Backfills: wie weit zurück Läufe und Tageswerte " +
				"geladen sind, wie viele FIT-Dateien ausgewertet sind, Fehler und geschätzte Restdauer.",
			inputSchema: z.object({}),
		},
		async () => json(await syncStatus(db, userId)),
	);

	server.registerTool(
		"get_daily_health",
		{
			description:
				"Tageswerte pro Tag plus Mittelwerte: Schritte, Ruhepuls, HRV, Schlaf (Dauer, Phasen, Score), Body Battery, Stress, Intensitätsminuten.",
			inputSchema: z.object({
				start_date: DATE.optional().describe("Erster Tag (YYYY-MM-DD); Standard: vor 7 Tagen"),
				end_date: DATE.optional().describe("Letzter Tag (YYYY-MM-DD); Standard: heute"),
			}),
		},
		async ({ start_date, end_date }) => {
			const end = end_date ?? localDate(env.TIMEZONE);
			const start = start_date ?? addDays(end, -6);
			if (start > end) return { ...json({ error: "start_date liegt nach end_date" }), isError: true };
			if (addDays(start, 92) < end) return { ...json({ error: "Höchstens 92 Tage pro Abfrage" }), isError: true };
			const { results } = await db
				.prepare("SELECT * FROM daily_health WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date")
				.bind(userId, start, end)
				.all();
			const sync = await syncNote(db, userId);
			return json({ start, end, average: dailyAverages(results), days: results.map(dailyHealth), ...sync });
		},
	);
}

/** Kurzer Abgleich-Hinweis für Antworten mit Daten. */
async function syncNote(db: D1Database, userId: number) {
	const user = await db
		.prepare("SELECT last_sync_at, last_sync_error FROM users WHERE id = ?")
		.bind(userId)
		.first<{ last_sync_at: string | null; last_sync_error: string | null }>();
	if (!user?.last_sync_at) return { note: "Noch kein Abgleich mit Garmin erfolgt (läuft alle 30 Minuten)." };
	return user.last_sync_error
		? { last_sync_at: user.last_sync_at, last_sync_error: user.last_sync_error }
		: { last_sync_at: user.last_sync_at };
}
