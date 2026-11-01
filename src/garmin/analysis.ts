import type { FitMessages } from "@garmin/fitsdk";

/**
 * Kennzahlen eines Laufs aus den Sekundendaten (record-Nachrichten) der FIT-Datei.
 * Bei einer Berechnungsänderung METRICS_VERSION erhöhen: dann wird die Historie neu gerechnet.
 */
export const METRICS_VERSION = 1;

// Lücken über dieser Dauer gelten als Pause (Timer gestoppt) und zählen nicht.
const MAX_GAP_S = 10;
// Unter diesem Tempo (m/s, ≈ 33 min/km) gilt ein Abschnitt als Stehen.
const MIN_MOVING_SPEED = 0.5;
// Kürzere Läufe haben keine aussagekräftige HF-Drift.
const MIN_DRIFT_MOVING_S = 20 * 60;
export const HR_BIN_BPM = 5;
// Höhenänderungen zählen erst ab dieser Schwelle; glättet das Rauschen des Höhenmessers
// (an einem echten Lauf geprüft: ergibt etwa Garmins Höhenmeter).
const ALTITUDE_HYSTERESIS_M = 1.2;

export type Split = {
	km: number;
	distance_m: number;
	time_s: number;
	avg_hr: number | null;
	ascent_m: number;
	descent_m: number;
};

export type HrBin = { bpm_low: number; seconds: number; meters: number };

export type RunMetrics = {
	metrics_version: number;
	moving_s: number;
	distance_m: number;
	// Obergrenzen der Zonen 1–5 und Untergrenze von Zone 1, wie auf der Uhr: [z1_low, z1_high, …, z5_high].
	zone_bounds: number[] | null;
	zone_calc: string | null;
	// Sekunden pro Zone 0–5 laut Uhr (Zone 0 = unter Zone 1).
	zone_s: number[] | null;
	// Aus den Sekundendaten: Bewegungszeit und Meter pro Zone 0–5, Grundlage für Pace pro Zone.
	zone_moving_s: number[] | null;
	zone_m: number[] | null;
	hr_drift_pct: number | null;
	pace_cv_pct: number | null;
	splits: Split[];
	hr_bins: HrBin[];
};

type Sample = { t: number; d: number; hr: number | null; alt: number | null };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function samples(messages: FitMessages): Sample[] {
	const out: Sample[] = [];
	for (const r of messages.recordMesgs ?? []) {
		const t = r.timestamp instanceof Date ? r.timestamp.getTime() / 1000 : num(r.timestamp);
		const d = num(r.distance);
		if (t === null || d === null) continue;
		out.push({ t, d, hr: num(r.heartRate), alt: num(r.enhancedAltitude) ?? num(r.altitude) });
	}
	return out.sort((a, b) => a.t - b.t);
}

/** Zonengrenzen und Zeit pro Zone aus der time_in_zone-Nachricht der Session. */
function sessionZones(messages: FitMessages) {
	const z = (messages.timeInZoneMesgs ?? []).find(
		(m) => m.referenceMesg === ("session" as unknown) || m.referenceMesg === 18,
	);
	const bounds = z?.hrZoneHighBoundary?.filter((b) => typeof b === "number");
	if (!z || !bounds || bounds.length < 6) return null;
	return {
		bounds: bounds.slice(0, 6),
		calc: typeof z.hrCalcType === "string" ? z.hrCalcType : null,
		seconds: (z.timeInHrZone ?? []).slice(0, 6).map((s) => Math.round(num(s) ?? 0)),
	};
}

/** Zone 0–5 nach Garmin-Logik: Der Grenzwert gehört schon zur höheren Zone (an FIT-Daten geprüft). */
export function zoneOf(hr: number, bounds: number[]): number {
	let zone = 0;
	for (let i = 0; i < 5; i++) if (hr >= bounds[i]) zone = i + 1;
	return zone;
}

/** Anstieg/Abstieg je Abschnitt i → i+1, mit Hysterese gegen Messrauschen. */
function altitudeChanges(s: Sample[]): { up: number; down: number }[] {
	const out = s.map(() => ({ up: 0, down: 0 }));
	let ref: number | null = null;
	for (let i = 1; i < s.length; i++) {
		const alt = s[i].alt;
		if (alt === null) continue;
		if (ref === null) ref = s[i - 1].alt ?? alt;
		if (alt - ref >= ALTITUDE_HYSTERESIS_M) {
			out[i - 1].up = alt - ref;
			ref = alt;
		} else if (ref - alt >= ALTITUDE_HYSTERESIS_M) {
			out[i - 1].down = ref - alt;
			ref = alt;
		}
	}
	return out;
}

export function analyzeRun(messages: FitMessages): RunMetrics {
	const s = samples(messages);
	const zones = sessionZones(messages);
	const zoneMovingS = zones ? [0, 0, 0, 0, 0, 0] : null;
	const zoneM = zones ? [0, 0, 0, 0, 0, 0] : null;
	const bins = new Map<number, HrBin>();
	const splits: Split[] = [];
	// Für die Drift: Bewegungsabschnitte mit Puls (Dauer, Meter, Herzschläge).
	const moving: { dt: number; dd: number; beats: number }[] = [];

	const alt = altitudeChanges(s);
	let movingS = 0;
	let split = { start: 0, time: 0, hrTime: 0, beats: 0, up: 0, down: 0 };

	for (let i = 0; i + 1 < s.length; i++) {
		const a = s[i];
		const b = s[i + 1];
		const dt = b.t - a.t;
		if (dt <= 0 || dt > MAX_GAP_S) continue;
		const dd = Math.max(0, b.d - a.d);

		// Kilometer-Splits: Grenze innerhalb des Abschnitts linear interpolieren.
		let restDt = dt;
		let restDd = dd;
		let pos = a.d;
		while (pos + restDd >= split.start + 1000 && restDd > 0) {
			const need = split.start + 1000 - pos;
			const frac = need / restDd;
			const partDt = restDt * frac;
			split.time += partDt;
			if (a.hr !== null) {
				split.hrTime += partDt;
				split.beats += a.hr * partDt;
			}
			splits.push(finishSplit(splits.length + 1, 1000, split));
			split = { start: split.start + 1000, time: 0, hrTime: 0, beats: 0, up: 0, down: 0 };
			pos += need;
			restDt -= partDt;
			restDd -= need;
		}
		split.time += restDt;
		if (a.hr !== null) {
			split.hrTime += restDt;
			split.beats += a.hr * restDt;
		}
		// Höhenänderung zählt zu dem Kilometer, in dem der Abschnitt endet.
		split.up += alt[i].up;
		split.down += alt[i].down;

		const isMoving = dd / dt >= MIN_MOVING_SPEED;
		if (!isMoving) continue;
		movingS += dt;
		if (a.hr === null) continue;
		moving.push({ dt, dd, beats: a.hr * dt });
		const low = Math.floor(a.hr / HR_BIN_BPM) * HR_BIN_BPM;
		const bin = bins.get(low) ?? { bpm_low: low, seconds: 0, meters: 0 };
		bin.seconds += dt;
		bin.meters += dd;
		bins.set(low, bin);
		if (zones && zoneMovingS && zoneM) {
			const z = zoneOf(a.hr, zones.bounds);
			zoneMovingS[z] += dt;
			zoneM[z] += dd;
		}
	}
	const total = s.length ? s[s.length - 1].d : 0;
	// Letzter angefangener Kilometer, wenn er mindestens 50 m lang ist.
	if (total - split.start >= 50) splits.push(finishSplit(splits.length + 1, total - split.start, split));

	return {
		metrics_version: METRICS_VERSION,
		moving_s: Math.round(movingS),
		distance_m: Math.round(total),
		zone_bounds: zones?.bounds ?? null,
		zone_calc: zones?.calc ?? null,
		zone_s: zones?.seconds ?? null,
		zone_moving_s: zoneMovingS?.map(Math.round) ?? null,
		zone_m: zoneM?.map(Math.round) ?? null,
		hr_drift_pct: hrDrift(moving),
		pace_cv_pct: paceCv(splits),
		splits,
		hr_bins: [...bins.values()]
			.sort((x, y) => x.bpm_low - y.bpm_low)
			.map((b) => ({ bpm_low: b.bpm_low, seconds: Math.round(b.seconds), meters: Math.round(b.meters) })),
	};
}

function finishSplit(
	km: number,
	distance: number,
	s: { time: number; hrTime: number; beats: number; up: number; down: number },
): Split {
	return {
		km,
		distance_m: Math.round(distance),
		time_s: Math.round(s.time * 10) / 10,
		avg_hr: s.hrTime > 0 ? Math.round(s.beats / s.hrTime) : null,
		ascent_m: Math.round(s.up),
		descent_m: Math.round(s.down),
	};
}

/**
 * HF-Drift (Pa:HR-Entkopplung): Effizienz = Meter pro Herzschlag in der ersten und
 * zweiten Hälfte der Bewegungszeit. Positiv = in der zweiten Hälfte mehr Puls fürs gleiche Tempo.
 */
function hrDrift(moving: { dt: number; dd: number; beats: number }[]): number | null {
	const total = moving.reduce((sum, m) => sum + m.dt, 0);
	if (total < MIN_DRIFT_MOVING_S) return null;
	const half = [
		{ dd: 0, beats: 0 },
		{ dd: 0, beats: 0 },
	];
	let t = 0;
	for (const m of moving) {
		const h = half[t < total / 2 ? 0 : 1];
		h.dd += m.dd;
		h.beats += m.beats;
		t += m.dt;
	}
	if (!half[0].beats || !half[1].beats) return null;
	const ef1 = half[0].dd / half[0].beats;
	const ef2 = half[1].dd / half[1].beats;
	return Math.round(((ef1 - ef2) / ef1) * 1000) / 10;
}

/** Streuung der Pace über volle Kilometer: Variationskoeffizient in %. */
function paceCv(splits: Split[]): number | null {
	const paces = splits.filter((s) => s.distance_m === 1000 && s.time_s > 0).map((s) => s.time_s);
	if (paces.length < 2) return null;
	const mean = paces.reduce((a, b) => a + b, 0) / paces.length;
	const sd = Math.sqrt(paces.reduce((a, b) => a + (b - mean) ** 2, 0) / paces.length);
	return Math.round((sd / mean) * 1000) / 10;
}
