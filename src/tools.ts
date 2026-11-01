import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { addDays, localDate } from "./dates";
import { activityDetail, activitySummary, dailyAverages, dailyHealth } from "./format";

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
			const sync = await syncStatus(db, userId);
			return json({ since, count: results.length, activities: results.map(activitySummary), ...sync });
		},
	);

	server.registerTool(
		"get_activity_detail",
		{
			description:
				"Details einer Aktivität: Kennzahlen, Minuten pro Herzfrequenzzone und Runden (aus der FIT-Datei).",
			inputSchema: z.object({ activity_id: z.number().int().describe("ID aus get_recent_activities") }),
		},
		async ({ activity_id }) => {
			const activity = await db
				.prepare("SELECT * FROM activities WHERE user_id = ? AND activity_id = ?")
				.bind(userId, activity_id)
				.first();
			if (!activity) return { ...json({ error: `Aktivität ${activity_id} nicht gefunden` }), isError: true };
			const { results: laps } = await db
				.prepare("SELECT * FROM laps WHERE user_id = ? AND activity_id = ? ORDER BY lap_index")
				.bind(userId, activity_id)
				.all();
			return json(activityDetail(activity, laps));
		},
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
			const sync = await syncStatus(db, userId);
			return json({ start, end, average: dailyAverages(results), days: results.map(dailyHealth), ...sync });
		},
	);
}

async function syncStatus(db: D1Database, userId: number) {
	const user = await db
		.prepare("SELECT last_sync_at, last_sync_error FROM users WHERE id = ?")
		.bind(userId)
		.first<{ last_sync_at: string | null; last_sync_error: string | null }>();
	if (!user?.last_sync_at) return { note: "Noch kein Abgleich mit Garmin erfolgt (läuft alle 30 Minuten)." };
	return user.last_sync_error
		? { last_sync_at: user.last_sync_at, last_sync_error: user.last_sync_error }
		: { last_sync_at: user.last_sync_at };
}
