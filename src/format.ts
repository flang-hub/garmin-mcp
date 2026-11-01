/**
 * Kompakte Kennzahlen für die MCP-Werkzeuge: gerundet, mit Einheit im Feldnamen,
 * leere Werte weggelassen. So bleibt die Antwort für Claude klein und eindeutig.
 */

type Row = Record<string, unknown>;

const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round = (v: number | null, digits = 0) => (v === null ? null : Math.round(v * 10 ** digits) / 10 ** digits);

/** Entfernt null/undefined, damit die Antwort kompakt bleibt. */
export function compact<T extends Row>(row: T): Partial<T> {
	return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;
}

export function formatDuration(seconds: number | null): string | null {
	if (seconds === null) return null;
	const s = Math.round(seconds);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = String(s % 60).padStart(2, "0");
	return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

const PACE_TYPES = /running|walking|hiking|trail|treadmill/;

/** Lauf/Gehen: Pace in min/km; Schwimmen: min/100 m; sonst km/h. */
export function speedFields(typeKey: unknown, mps: unknown): Row {
	const v = n(mps);
	if (v === null || v <= 0) return {};
	const type = typeof typeKey === "string" ? typeKey : "";
	if (PACE_TYPES.test(type)) return { pace_min_per_km: formatDuration(1000 / v) };
	if (type.includes("swim")) return { pace_min_per_100m: formatDuration(100 / v) };
	return { speed_kmh: round(v * 3.6, 1) };
}

export function activitySummary(a: Row) {
	return compact({
		activity_id: a.activity_id,
		date: typeof a.start_time_local === "string" ? a.start_time_local.slice(0, 16) : null,
		name: a.name,
		type: a.type_key,
		distance_km: round(n(a.distance_m) === null ? null : n(a.distance_m)! / 1000, 2),
		duration: formatDuration(n(a.duration_s)),
		...speedFields(a.type_key, a.avg_speed_mps),
		avg_hr: round(n(a.avg_hr)),
		elevation_gain_m: round(n(a.elevation_gain_m)),
		training_load: round(n(a.training_load)),
		aerobic_te: round(n(a.aerobic_te), 1),
	});
}

export function activityDetail(a: Row, laps: Row[]) {
	let zones: (number | null)[] = [];
	try {
		zones = typeof a.hr_zones_s === "string" ? JSON.parse(a.hr_zones_s) : [];
	} catch {
		zones = [];
	}
	return compact({
		...activitySummary(a),
		moving_duration: formatDuration(n(a.moving_duration_s)),
		max_hr: round(n(a.max_hr)),
		elevation_loss_m: round(n(a.elevation_loss_m)),
		calories: round(n(a.calories)),
		avg_cadence: round(n(a.avg_cadence)),
		avg_power_w: round(n(a.avg_power)),
		norm_power_w: round(n(a.norm_power)),
		anaerobic_te: round(n(a.anaerobic_te), 1),
		vo2max: round(n(a.vo2max)),
		hr_zone_minutes: zones.length ? zones.map((s) => round(n(s) === null ? 0 : n(s)! / 60, 1)) : null,
		laps_status: a.fit_r2_key ? null : a.fit_error ? `Runden nicht verfügbar: ${a.fit_error}` : "Runden werden noch geladen",
		laps: laps.length
			? laps.map((l) =>
					compact({
						lap: n(l.lap_index) === null ? null : n(l.lap_index)! + 1,
						distance_km: round(n(l.distance_m) === null ? null : n(l.distance_m)! / 1000, 2),
						time: formatDuration(n(l.timer_s) ?? n(l.elapsed_s)),
						...speedFields(a.type_key, l.avg_speed_mps),
						avg_hr: round(n(l.avg_hr)),
						max_hr: round(n(l.max_hr)),
						cadence: round(n(l.avg_cadence)),
						power_w: round(n(l.avg_power)),
						ascent_m: round(n(l.ascent_m)),
					}),
				)
			: null,
	});
}

const hours = (s: unknown) => round(n(s) === null ? null : n(s)! / 3600, 1);

export function dailyHealth(d: Row) {
	return compact({
		date: d.date,
		steps: d.steps,
		resting_hr: d.resting_hr,
		hrv_last_night_ms: d.hrv_last_night_avg,
		hrv_weekly_avg_ms: d.hrv_weekly_avg,
		hrv_status: d.hrv_status,
		sleep_h: hours(d.sleep_s),
		sleep_deep_h: hours(d.sleep_deep_s),
		sleep_rem_h: hours(d.sleep_rem_s),
		sleep_score: d.sleep_score,
		body_battery_max: d.body_battery_max,
		body_battery_min: d.body_battery_min,
		stress_avg: d.stress_avg,
		intensity_min: n(d.intensity_min_moderate) === null && n(d.intensity_min_vigorous) === null
			? null
			: (n(d.intensity_min_moderate) ?? 0) + 2 * (n(d.intensity_min_vigorous) ?? 0),
		active_kcal: d.active_kcal,
		respiration_avg: d.respiration_avg,
		spo2_avg: d.spo2_avg,
	});
}

/** Mittelwerte über den Zeitraum für die wichtigsten Kennzahlen. */
export function dailyAverages(rows: Row[]) {
	const avg = (key: string, digits = 0) => {
		const vals = rows.map((r) => n(r[key])).filter((v) => v !== null);
		return vals.length ? round(vals.reduce((s, v) => s + v, 0) / vals.length, digits) : null;
	};
	return compact({
		days: rows.length,
		steps: avg("steps"),
		resting_hr: avg("resting_hr"),
		hrv_last_night_ms: avg("hrv_last_night_avg"),
		sleep_h: (() => {
			const v = avg("sleep_s");
			return v === null ? null : round(v / 3600, 1);
		})(),
		sleep_score: avg("sleep_score"),
		stress_avg: avg("stress_avg"),
	});
}
