import { addDays } from "./dates";
import { RUN_SQL } from "./files";
import { HR_BIN_BPM } from "./garmin/analysis";
import { formatDuration } from "./format";

/**
 * Wochen- und Trendauswertungen. Wochen laufen von Montag bis Sonntag;
 * maßgeblich ist die lokale Startzeit des Laufs bzw. das Kalenderdatum der Tageswerte.
 */

type Row = Record<string, unknown>;
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round = (v: number | null, digits = 0) => (v === null ? null : Math.round(v * 10 ** digits) / 10 ** digits);
const parse = <T>(v: unknown): T | null => {
	try {
		return typeof v === "string" ? (JSON.parse(v) as T) : null;
	} catch {
		return null;
	}
};

/** Montag der Woche, in der das Datum liegt. */
export function weekStart(date: string): string {
	const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
	const offset = (d.getUTCDay() + 6) % 7;
	return addDays(date.slice(0, 10), -offset);
}

/** Alle Wochenanfänge von start bis end (jeweils Montag). */
export function weeksBetween(start: string, end: string): string[] {
	const out = [];
	for (let w = weekStart(start); w <= end; w = addDays(w, 7)) out.push(w);
	return out;
}

const WEEK_SQL = (col: string) => `date(substr(${col}, 1, 10), '-6 days', 'weekday 1')`;
const paceString = (secPerKm: number | null) => (secPerKm === null ? null : formatDuration(secPerKm));

/** Veränderung der Pace in Worten; unter einer Sekunde gilt als unverändert. */
export function paceChange(first: number, last: number): string {
	const diff = Math.round(first - last);
	if (diff === 0) return "unverändert";
	return `${diff > 0 ? "schneller" : "langsamer"} um ${formatDuration(Math.abs(diff))} min/km`;
}

async function runsInRange(db: D1Database, userId: number, start: string, end: string) {
	const { results } = await db
		.prepare(
			`SELECT a.activity_id, a.start_time_local, a.distance_m, a.duration_s, a.training_load, a.hr_zones_s,
			        ${WEEK_SQL("a.start_time_local")} AS week,
			        m.zone_moving_s, m.zone_m, m.zone_bounds, m.hr_drift_pct
			 FROM activities a
			 LEFT JOIN activity_metrics m ON m.user_id = a.user_id AND m.activity_id = a.activity_id
			 WHERE a.user_id = ?1 AND a.${RUN_SQL} AND substr(a.start_time_local, 1, 10) BETWEEN ?2 AND ?3
			 ORDER BY a.start_time_local`,
		)
		.bind(userId, start, end)
		.all();
	return results;
}

const HEALTH_AVG_COLUMNS = {
	resting_hr: "avg(resting_hr)",
	hrv_ms: "avg(hrv_last_night_avg)",
	sleep_h: "avg(sleep_s) / 3600.0",
	sleep_score: "avg(sleep_score)",
	body_battery_max: "avg(body_battery_max)",
	stress_avg: "avg(stress_avg)",
} as const;

async function healthByWeek(db: D1Database, userId: number, start: string, end: string) {
	const { results } = await db
		.prepare(
			`SELECT ${WEEK_SQL("date")} AS week, count(*) AS days,
			        ${Object.entries(HEALTH_AVG_COLUMNS).map(([k, sql]) => `${sql} AS ${k}`).join(", ")}
			 FROM daily_health WHERE user_id = ? AND date BETWEEN ? AND ? GROUP BY week`,
		)
		.bind(userId, start, end)
		.all();
	return new Map(results.map((r) => [r.week as string, r]));
}

export async function weeklySummary(db: D1Database, userId: number, start: string, end: string) {
	const weeks = weeksBetween(start, end);
	const from = weeks[0];
	const runs = await runsInRange(db, userId, from, end);
	const health = await healthByWeek(db, userId, from, end);
	return weeks.map((week) => {
		const r = runs.filter((x) => x.week === week);
		const km = r.reduce((s, x) => s + (n(x.distance_m) ?? 0), 0) / 1000;
		const sec = r.reduce((s, x) => s + (n(x.duration_s) ?? 0), 0);
		const zones = [0, 0, 0, 0, 0];
		for (const x of r) parse<(number | null)[]>(x.hr_zones_s)?.forEach((s, i) => (zones[i] += n(s) ?? 0));
		const h = health.get(week);
		return {
			week,
			runs: r.length,
			km: round(km, 1),
			time: formatDuration(sec),
			avg_pace_min_per_km: km > 0 ? paceString(sec / km) : null,
			long_run_km: r.length ? round(Math.max(...r.map((x) => n(x.distance_m) ?? 0)) / 1000, 1) : null,
			training_load: round(r.reduce((s, x) => s + (n(x.training_load) ?? 0), 0)),
			zone_minutes: r.length ? zones.map((s) => round(s / 60)) : null,
			recovery: h
				? {
						days: h.days,
						resting_hr: round(n(h.resting_hr)),
						hrv_ms: round(n(h.hrv_ms)),
						sleep_h: round(n(h.sleep_h), 1),
						sleep_score: round(n(h.sleep_score)),
						body_battery_max: round(n(h.body_battery_max)),
						stress_avg: round(n(h.stress_avg)),
					}
				: null,
		};
	});
}

export const TREND_METRICS = [
	"pace_zone",
	"pace_hr",
	"hr_drift",
	"weekly_km",
	"long_run_km",
	"runs",
	"resting_hr",
	"hrv_ms",
	"sleep_h",
	"sleep_score",
	"body_battery_max",
	"stress_avg",
] as const;
export type TrendMetric = (typeof TREND_METRICS)[number];

// Wochen mit weniger Minuten im Bereich sind für Pace-Trends wenig aussagekräftig.
const LOW_DATA_MIN = 10;

type WeekValue = { week: string; value: number | null; basis?: Record<string, unknown> };

export async function trend(
	db: D1Database,
	userId: number,
	metric: TrendMetric,
	start: string,
	end: string,
	opts: { zone?: number; hr_min?: number; hr_max?: number },
) {
	const weeks = weeksBetween(start, end);
	const from = weeks[0];
	let values: WeekValue[];
	let unit: string;
	const info: Record<string, unknown> = {};

	if (metric === "pace_zone" || metric === "pace_hr" || metric === "hr_drift" || metric.endsWith("km") || metric === "runs") {
		const runs = await runsInRange(db, userId, from, end);
		const byWeek = (week: string) => runs.filter((r) => r.week === week);

		if (metric === "pace_zone") {
			const zone = opts.zone ?? 2;
			unit = "min/km";
			const bounds = new Set<string>();
			values = weeks.map((week) => {
				let s = 0;
				let m = 0;
				for (const r of byWeek(week)) {
					const zs = parse<number[]>(r.zone_moving_s);
					const zm = parse<number[]>(r.zone_m);
					const b = parse<number[]>(r.zone_bounds);
					if (!zs || !zm || !b) continue;
					s += zs[zone] ?? 0;
					m += zm[zone] ?? 0;
					if ((zs[zone] ?? 0) > 0) bounds.add(`${b[zone - 1]}–${b[zone] - 1} bpm`);
				}
				return { week, value: m > 0 ? (s / m) * 1000 : null, basis: { minutes: round(s / 60), km: round(m / 1000, 1) } };
			});
			info.zone = zone;
			info.zone_bounds_used = [...bounds];
			info.note = "Zonen wie auf der Uhr beim jeweiligen Lauf (Garmin-Zonen); Pace nur aus Bewegungszeit.";
		} else if (metric === "pace_hr") {
			if (opts.hr_min === undefined || opts.hr_max === undefined || opts.hr_max <= opts.hr_min) {
				throw new Error("pace_hr braucht hr_min und hr_max (z. B. 140 und 150)");
			}
			const lo = Math.floor(opts.hr_min / HR_BIN_BPM) * HR_BIN_BPM;
			const hi = Math.ceil(opts.hr_max / HR_BIN_BPM) * HR_BIN_BPM;
			const { results } = await db
				.prepare(
					`SELECT ${WEEK_SQL("a.start_time_local")} AS week, sum(b.seconds) AS s, sum(b.meters) AS m
					 FROM activity_hr_bins b
					 JOIN activities a ON a.user_id = b.user_id AND a.activity_id = b.activity_id
					 WHERE b.user_id = ?1 AND b.bpm_low >= ?2 AND b.bpm_low < ?3
					   AND substr(a.start_time_local, 1, 10) BETWEEN ?4 AND ?5
					 GROUP BY week`,
				)
				.bind(userId, lo, hi, from, end)
				.all();
			const map = new Map(results.map((r) => [r.week as string, r]));
			unit = "min/km";
			values = weeks.map((week) => {
				const r = map.get(week);
				const s = n(r?.s) ?? 0;
				const m = n(r?.m) ?? 0;
				return { week, value: m > 0 ? (s / m) * 1000 : null, basis: { minutes: round(s / 60), km: round(m / 1000, 1) } };
			});
			info.hr_range = `${lo}–${hi - 1} bpm`;
			info.note = "Pace nur aus Bewegungszeit mit Herzfrequenz im Bereich.";
		} else if (metric === "hr_drift") {
			unit = "%";
			values = weeks.map((week) => {
				const d = byWeek(week)
					.map((r) => n(r.hr_drift_pct))
					.filter((v) => v !== null);
				return { week, value: d.length ? d.reduce((a, b) => a + b, 0) / d.length : null, basis: { runs: d.length } };
			});
			info.note = "Pa:HR-Entkopplung je Lauf ab 20 min, Wochenmittel; positiv = Puls steigt bei gleichem Tempo.";
		} else {
			unit = metric === "runs" ? "Läufe" : "km";
			values = weeks.map((week) => {
				const r = byWeek(week);
				const dist = r.map((x) => (n(x.distance_m) ?? 0) / 1000);
				const value =
					metric === "runs" ? r.length : metric === "weekly_km" ? dist.reduce((a, b) => a + b, 0) : dist.length ? Math.max(...dist) : null;
				return { week, value };
			});
		}
	} else {
		const health = await healthByWeek(db, userId, from, end);
		const units = { resting_hr: "bpm", hrv_ms: "ms", sleep_h: "h", sleep_score: "Punkte", body_battery_max: "Punkte", stress_avg: "Punkte" };
		unit = units[metric as keyof typeof units];
		values = weeks.map((week) => {
			const h = health.get(week);
			return { week, value: h ? n(h[metric]) : null, basis: h ? { days: h.days } : undefined };
		});
	}

	const isPace = unit === "min/km";
	const present = values.filter((v) => v.value !== null) as { week: string; value: number }[];
	const avg = (xs: { value: number }[]) => (xs.length ? xs.reduce((a, b) => a + b.value, 0) / xs.length : null);
	const fmt = (v: number | null) => (isPace ? paceString(v) : round(v, 1));
	const first = avg(present.slice(0, 4));
	const last = avg(present.slice(-4));

	return {
		metric,
		unit,
		start: from,
		end,
		...info,
		weeks: values.map((v) => ({
			week: v.week,
			value: fmt(v.value),
			...(v.basis ?? {}),
			...(isPace && v.value !== null && n(v.basis?.minutes) !== null && (v.basis!.minutes as number) < LOW_DATA_MIN
				? { low_data: true }
				: {}),
		})),
		summary: present.length
			? {
					weeks_with_data: present.length,
					first_4_weeks_avg: fmt(first),
					last_4_weeks_avg: fmt(last),
					change: isPace ? paceChange(first!, last!) : round(last! - first!, 1),
				}
			: { weeks_with_data: 0 },
	};
}

/** Stand von Abgleich und Backfill für get_sync_status. */
export async function syncStatus(db: D1Database, userId: number) {
	const user = await db
		.prepare("SELECT last_sync_at, last_sync_error FROM users WHERE id = ?")
		.bind(userId)
		.first<{ last_sync_at: string | null; last_sync_error: string | null }>();
	const { results: jobs } = await db.prepare("SELECT * FROM backfill_jobs WHERE user_id = ? ORDER BY job").bind(userId).all();
	const runs = await db
		.prepare(
			`SELECT count(*) AS total,
			        sum(a.fit_r2_key IS NOT NULL) AS with_fit,
			        sum(m.activity_id IS NOT NULL) AS with_metrics,
			        sum(a.fit_error IS NOT NULL) AS fit_errors,
			        min(substr(a.start_time_local, 1, 10)) AS oldest,
			        max(substr(a.start_time_local, 1, 10)) AS newest
			 FROM activities a LEFT JOIN activity_metrics m ON m.user_id = a.user_id AND m.activity_id = a.activity_id
			 WHERE a.user_id = ? AND a.${RUN_SQL}`,
		)
		.bind(userId)
		.first<Row>();
	const health = await db
		.prepare("SELECT count(*) AS days, min(date) AS oldest, max(date) AS newest FROM daily_health WHERE user_id = ?")
		.bind(userId)
		.first<Row>();
	const pendingFiles = (n(runs?.total) ?? 0) - (n(runs?.with_metrics) ?? 0) - (n(runs?.fit_errors) ?? 0);
	// Pro Stunde: 6 Backfill-Aufrufe und 2 Abgleiche mit je einer Datei.
	const filesPerHour = 8;
	return {
		last_sync_at: user?.last_sync_at ?? null,
		last_sync_error: user?.last_sync_error ?? null,
		runs: {
			stored: runs?.total ?? 0,
			oldest: runs?.oldest ?? null,
			newest: runs?.newest ?? null,
			with_fit_file: runs?.with_fit ?? 0,
			with_metrics: runs?.with_metrics ?? 0,
			fit_errors: runs?.fit_errors ?? 0,
			files_pending: Math.max(0, pendingFiles),
			files_eta_h: pendingFiles > 0 ? round(pendingFiles / filesPerHour, 1) : 0,
		},
		daily_health: health,
		backfill: jobs.map((j) => ({
			job: j.job,
			done: j.job === "files" ? pendingFiles <= 0 : Boolean(j.done),
			reached: j.cursor,
			target: j.target,
			processed: j.processed,
			...(j.last_error ? { last_error: j.last_error, failures: j.failures, retry_after: j.retry_after } : {}),
			last_run_at: j.last_run_at,
		})),
	};
}
