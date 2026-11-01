import { Decoder, type FitMessages, Stream } from "@garmin/fitsdk";
import { unzipSync } from "fflate";

/**
 * Der Garmin-Download liefert die Originaldatei in einem ZIP. Wir holen die
 * FIT-Datei heraus. Ist die Antwort schon eine FIT-Datei, wird sie direkt genutzt.
 */
export function extractFit(download: Uint8Array): Uint8Array {
	if (isFit(download)) return download;
	const files = unzipSync(download);
	const name = Object.keys(files).find((n) => n.toLowerCase().endsWith(".fit"));
	if (!name) throw new Error(`Keine FIT-Datei im Download (Inhalt: ${Object.keys(files).join(", ") || "leer"})`);
	return files[name];
}

function isFit(bytes: Uint8Array): boolean {
	// Bytes 8–11 des Headers enthalten ".FIT".
	return bytes.length >= 12 && bytes[8] === 0x2e && bytes[9] === 0x46 && bytes[10] === 0x49 && bytes[11] === 0x54;
}

export type Lap = {
	lap_index: number;
	start_time: string | null;
	elapsed_s: number | null;
	timer_s: number | null;
	distance_m: number | null;
	avg_speed_mps: number | null;
	max_speed_mps: number | null;
	avg_hr: number | null;
	max_hr: number | null;
	avg_cadence: number | null;
	avg_power: number | null;
	ascent_m: number | null;
	descent_m: number | null;
	calories: number | null;
	lap_trigger: string | null;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// Bei diesen Sportarten speichert FIT die Kadenz in Doppelschritten pro Minute.
const STEP_SPORTS = new Set(["running", "walking", "hiking"]);

/**
 * Kadenz wie in Garmin Connect: bei Schrittsportarten in Schritten pro Minute
 * (Doppelschritte × 2, inklusive Nachkommaanteil), sonst unverändert (z. B. U/min beim Rad).
 */
function lapCadence(l: { avgRunningCadence?: number; avgCadence?: number; avgFractionalCadence?: number }, sport: unknown) {
	const base = num(l.avgRunningCadence) ?? num(l.avgCadence);
	if (base === null) return null;
	if (typeof sport !== "string" || !STEP_SPORTS.has(sport)) return base;
	return Math.round((base + (num(l.avgFractionalCadence) ?? 0)) * 2);
}

/** Dekodiert eine FIT-Datei einmal; Runden und Kennzahlen lesen daraus. */
export function decodeFit(fit: Uint8Array): FitMessages {
	const { messages, errors } = new Decoder(Stream.fromByteArray(fit)).read();
	if (errors.length && !messages.lapMesgs?.length && !messages.recordMesgs?.length) throw errors[0];
	return messages;
}

/** Liest die Runden (lap-Nachrichten). */
export function parseLaps(messages: FitMessages): Lap[] {
	const sessionSport = messages.sessionMesgs?.[0]?.sport;
	return (messages.lapMesgs ?? []).map((l, i) => {
		return {
			lap_index: typeof l.messageIndex === "number" ? l.messageIndex : i,
			start_time: l.startTime instanceof Date ? l.startTime.toISOString() : null,
			elapsed_s: num(l.totalElapsedTime),
			timer_s: num(l.totalTimerTime),
			distance_m: num(l.totalDistance),
			// Neuere Geräte schreiben Tempo nur in die "enhanced"-Felder.
			avg_speed_mps: num(l.enhancedAvgSpeed) ?? num(l.avgSpeed),
			max_speed_mps: num(l.enhancedMaxSpeed) ?? num(l.maxSpeed),
			avg_hr: num(l.avgHeartRate),
			max_hr: num(l.maxHeartRate),
			avg_cadence: lapCadence(l, l.sport ?? sessionSport),
			avg_power: num(l.avgPower),
			ascent_m: num(l.totalAscent),
			descent_m: num(l.totalDescent),
			calories: num(l.totalCalories),
			lap_trigger: typeof l.lapTrigger === "string" ? l.lapTrigger : null,
		};
	});
}
