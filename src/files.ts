import { markFitError, saveFitResults, startFitAttempt } from "./db";
import { analyzeRun, METRICS_VERSION } from "./garmin/analysis";
import { GarminApiError, type GarminClient } from "./garmin/client";
import { decodeFit, extractFit, parseLaps } from "./garmin/fit";

// Workers Free erlaubt nur 10 ms CPU pro Aufruf; Dekodieren braucht mehr. Wird ein Aufruf
// deshalb mehrfach abgebrochen, überspringen wir die Datei, statt sie endlos zu versuchen.
const MAX_FIT_ATTEMPTS = 3;

/** SQL-Bedingung für Läufe (running, trail_running, treadmill_running, virtual_run …). */
export const RUN_SQL = "type_key LIKE '%run%'";
export const isRun = (typeKey: unknown) => typeof typeKey === "string" && typeKey.includes("run");

export const fitKey = (userId: number, activityId: number) => `fit/${userId}/${activityId}.fit`;

type FileWork = { activity_id: number; type_key: string | null; fit_r2_key: string | null };

/**
 * Nächste Aktivitäten, deren Datei fehlt oder deren Kennzahlen fehlen bzw. veraltet sind.
 * Fehlende Dateien zuerst, jeweils die neuesten zuerst.
 */
export async function pendingFileWork(db: D1Database, userId: number, limit: number): Promise<FileWork[]> {
	const { results } = await db
		.prepare(
			`SELECT a.activity_id, a.type_key, a.fit_r2_key FROM activities a
			 LEFT JOIN activity_metrics m ON m.user_id = a.user_id AND m.activity_id = a.activity_id
			 WHERE a.user_id = ?1 AND a.fit_error IS NULL AND (
				a.fit_r2_key IS NULL
				OR (a.${RUN_SQL} AND (m.activity_id IS NULL OR m.metrics_version < ?2))
			 )
			 ORDER BY a.fit_r2_key IS NULL DESC, a.start_time_gmt DESC
			 LIMIT ?3`,
		)
		.bind(userId, METRICS_VERSION, limit)
		.all<FileWork>();
	return results;
}

/**
 * Holt die FIT-Datei (aus R2, sonst von Garmin), speichert sie in R2 und wertet sie aus.
 * Gibt "done" zurück oder "skipped", wenn die Aktivität einen Fehlervermerk bekommen hat.
 * Vorübergehende Garmin-Fehler (429, 5xx) werden geworfen, damit der Aufrufer pausiert.
 */
export async function processActivityFile(
	env: Env,
	userId: number,
	work: FileWork,
	client: GarminClient | null,
): Promise<"done" | "skipped" | "no_client"> {
	const id = work.activity_id;
	const key = work.fit_r2_key ?? fitKey(userId, id);

	let fit: Uint8Array | null = null;
	const stored = await env.FIT_BUCKET.get(key);
	if (stored) fit = new Uint8Array(await stored.arrayBuffer());
	if (!fit) {
		if (!client) return "no_client";
		try {
			fit = extractFit(await client.downloadActivity(id));
		} catch (err) {
			if (err instanceof GarminApiError && (err.status === 429 || err.status >= 500)) throw err;
			await markFitError(env.DB, userId, id, err instanceof Error ? err.message : String(err));
			return "skipped";
		}
		await env.FIT_BUCKET.put(key, fit, { httpMetadata: { contentType: "application/vnd.ant.fit" } });
	}

	// Ab hier wird es CPU-intensiv: Versuch vorher zählen, damit ein Abbruch nicht endlos wiederholt wird.
	const attempts = await startFitAttempt(env.DB, userId, id);
	if (attempts > MAX_FIT_ATTEMPTS) {
		await markFitError(env.DB, userId, id, `Auswertung ${MAX_FIT_ATTEMPTS}× abgebrochen (vermutlich CPU-Limit)`);
		return "skipped";
	}
	let laps;
	let metrics = null;
	try {
		const messages = decodeFit(fit);
		laps = parseLaps(messages);
		if (isRun(work.type_key)) metrics = analyzeRun(messages);
	} catch (err) {
		await markFitError(env.DB, userId, id, `FIT nicht lesbar: ${err instanceof Error ? err.message : err}`);
		return "skipped";
	}
	await saveFitResults(env.DB, userId, id, key, laps, metrics);
	return "done";
}
