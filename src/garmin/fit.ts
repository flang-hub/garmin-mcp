import { Decoder, Stream } from "@garmin/fitsdk";
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

/** Liest die Runden (lap-Nachrichten) aus einer FIT-Datei. */
export function parseLaps(fit: Uint8Array): Lap[] {
	const { messages, errors } = new Decoder(Stream.fromByteArray(fit)).read();
	if (errors.length && !messages.lapMesgs?.length) throw errors[0];
	return (messages.lapMesgs ?? []).map((lap, i) => {
		// Neuere Geräte schreiben Tempo nur in die "enhanced"-Felder.
		const l = lap as typeof lap & { enhancedAvgSpeed?: number; enhancedMaxSpeed?: number };
		return {
			lap_index: typeof l.messageIndex === "number" ? l.messageIndex : i,
			start_time: l.startTime instanceof Date ? l.startTime.toISOString() : null,
			elapsed_s: num(l.totalElapsedTime),
			timer_s: num(l.totalTimerTime),
			distance_m: num(l.totalDistance),
			avg_speed_mps: num(l.enhancedAvgSpeed) ?? num(l.avgSpeed),
			max_speed_mps: num(l.enhancedMaxSpeed) ?? num(l.maxSpeed),
			avg_hr: num(l.avgHeartRate),
			max_hr: num(l.maxHeartRate),
			avg_cadence: num(l.avgRunningCadence) ?? num(l.avgCadence),
			avg_power: num(l.avgPower),
			ascent_m: num(l.totalAscent),
			descent_m: num(l.totalDescent),
			calories: num(l.totalCalories),
			lap_trigger: typeof l.lapTrigger === "string" ? l.lapTrigger : null,
		};
	});
}
