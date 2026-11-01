/**
 * Wandelt Garmin-Antworten (Feldnamen laut offizieller Swagger-Doku) in Tabellenzeilen um.
 * Alle Zugriffe sind defensiv, weil Garmin Felder je nach Gerät weglässt.
 */

type Obj = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const int = (v: unknown): number | null => {
	const n = num(v);
	return n === null ? null : Math.round(n);
};
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

export type ActivityRow = {
	activity_id: number;
	name: string | null;
	type_key: string | null;
	start_time_local: string | null;
	start_time_gmt: string | null;
	duration_s: number | null;
	moving_duration_s: number | null;
	distance_m: number | null;
	elevation_gain_m: number | null;
	elevation_loss_m: number | null;
	avg_speed_mps: number | null;
	max_speed_mps: number | null;
	avg_hr: number | null;
	max_hr: number | null;
	calories: number | null;
	avg_power: number | null;
	norm_power: number | null;
	avg_cadence: number | null;
	aerobic_te: number | null;
	anaerobic_te: number | null;
	training_load: number | null;
	vo2max: number | null;
	hr_zones_s: string | null;
	lap_count: number | null;
	summary_json: string;
};

/** SummarizedActivityDTO aus der Aktivitätssuche → Zeile für activities. */
export function toActivityRow(a: Obj): ActivityRow | null {
	const id = num(a.activityId);
	if (id === null) return null;
	const zones = [1, 2, 3, 4, 5].map((z) => num(a[`hrTimeInZone_${z}`]));
	return {
		activity_id: id,
		name: str(a.activityName),
		type_key: str(obj(a.activityType).typeKey),
		start_time_local: str(a.startTimeLocal),
		start_time_gmt: str(a.startTimeGMT),
		duration_s: num(a.duration),
		moving_duration_s: num(a.movingDuration),
		distance_m: num(a.distance),
		elevation_gain_m: num(a.elevationGain),
		elevation_loss_m: num(a.elevationLoss),
		avg_speed_mps: num(a.averageSpeed),
		max_speed_mps: num(a.maxSpeed),
		avg_hr: num(a.averageHR),
		max_hr: num(a.maxHR),
		calories: num(a.calories),
		avg_power: num(a.avgPower),
		norm_power: num(a.normPower),
		avg_cadence: num(a.averageRunningCadenceInStepsPerMinute) ?? num(a.averageBikingCadenceInRevPerMinute),
		aerobic_te: num(a.aerobicTrainingEffect),
		anaerobic_te: num(a.anaerobicTrainingEffect),
		training_load: num(a.activityTrainingLoad),
		vo2max: num(a.vO2MaxValue),
		hr_zones_s: zones.some((z) => z !== null) ? JSON.stringify(zones) : null,
		lap_count: int(a.lapCount),
		summary_json: JSON.stringify(a),
	};
}

export type DailyHealthRow = {
	date: string;
	steps?: number | null;
	step_goal?: number | null;
	distance_m?: number | null;
	floors_up?: number | null;
	total_kcal?: number | null;
	active_kcal?: number | null;
	resting_hr?: number | null;
	min_hr?: number | null;
	max_hr?: number | null;
	intensity_min_moderate?: number | null;
	intensity_min_vigorous?: number | null;
	stress_avg?: number | null;
	stress_max?: number | null;
	body_battery_max?: number | null;
	body_battery_min?: number | null;
	body_battery_charged?: number | null;
	body_battery_drained?: number | null;
	respiration_avg?: number | null;
	spo2_avg?: number | null;
	sleep_s?: number | null;
	sleep_deep_s?: number | null;
	sleep_light_s?: number | null;
	sleep_rem_s?: number | null;
	sleep_awake_s?: number | null;
	sleep_score?: number | null;
	sleep_avg_hr?: number | null;
	hrv_last_night_avg?: number | null;
	hrv_weekly_avg?: number | null;
	hrv_status?: string | null;
};

export const DAILY_HEALTH_COLUMNS = [
	"steps",
	"step_goal",
	"distance_m",
	"floors_up",
	"total_kcal",
	"active_kcal",
	"resting_hr",
	"min_hr",
	"max_hr",
	"intensity_min_moderate",
	"intensity_min_vigorous",
	"stress_avg",
	"stress_max",
	"body_battery_max",
	"body_battery_min",
	"body_battery_charged",
	"body_battery_drained",
	"respiration_avg",
	"spo2_avg",
	"sleep_s",
	"sleep_deep_s",
	"sleep_light_s",
	"sleep_rem_s",
	"sleep_awake_s",
	"sleep_score",
	"sleep_avg_hr",
	"hrv_last_night_avg",
	"hrv_weekly_avg",
	"hrv_status",
] as const satisfies readonly (keyof DailyHealthRow)[];

function fromDailySummary(d: Obj): Partial<DailyHealthRow> {
	const movement = obj(d.movement);
	const steps = obj(movement.steps);
	const cal = obj(d.calories);
	const hr = obj(d.heartRate);
	const im = obj(d.intensityMinutes);
	const stress = obj(d.stress);
	const bb = obj(d.bodyBattery);
	return {
		steps: int(steps.value),
		step_goal: int(steps.goal),
		distance_m: num(steps.distanceInMeters),
		floors_up: num(obj(movement.floorsAscended).value),
		total_kcal: int(cal.burnedTotal),
		active_kcal: int(cal.burnedActive),
		resting_hr: int(hr.restingValue),
		min_hr: int(hr.minValue),
		max_hr: int(hr.maxValue),
		intensity_min_moderate: int(im.moderate),
		intensity_min_vigorous: int(im.vigorous),
		// Garmin meldet -1/-2, wenn kein Stresswert vorliegt.
		stress_avg: (int(stress.avgLevel) ?? -1) >= 0 ? int(stress.avgLevel) : null,
		stress_max: (int(stress.maxLevel) ?? -1) >= 0 ? int(stress.maxLevel) : null,
		body_battery_max: int(bb.maxValue),
		body_battery_min: int(bb.minValue),
		body_battery_charged: int(bb.chargedValue),
		body_battery_drained: int(bb.drainedValue),
		respiration_avg: int(obj(d.respiration).avgValue),
		spo2_avg: int(obj(d.pulseOx).avgValue),
	};
}

function fromSleep(s: Obj): Partial<DailyHealthRow> {
	const scores = obj(s.sleepScores);
	return {
		sleep_s: int(s.sleepTimeSeconds),
		sleep_deep_s: int(s.deepSleepSeconds),
		sleep_light_s: int(s.lightSleepSeconds),
		sleep_rem_s: int(s.remSleepSeconds),
		sleep_awake_s: int(s.awakeSleepSeconds),
		sleep_score: int(obj(scores.overall).value),
		sleep_avg_hr: num(s.avgHeartRate),
	};
}

function fromHrv(h: Obj): Partial<DailyHealthRow> {
	return {
		hrv_last_night_avg: int(h.lastNightAvg),
		hrv_weekly_avg: int(h.weeklyAvg),
		hrv_status: str(h.status),
	};
}

/** Führt Tageszusammenfassung, Schlaf und HRV pro Kalendertag zusammen. */
export function mergeDailyHealth(input: {
	summaries?: unknown;
	sleep?: unknown;
	hrv?: unknown;
}): DailyHealthRow[] {
	const byDate = new Map<string, DailyHealthRow>();
	const add = (date: unknown, part: Partial<DailyHealthRow>) => {
		const d = str(date);
		if (!d) return;
		byDate.set(d, { ...(byDate.get(d) ?? { date: d }), ...part, date: d });
	};
	const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);

	for (const d of list(obj(input.summaries).data)) add(d.calendarDate, fromDailySummary(d));
	for (const raw of list(input.sleep)) {
		// Manche Garmin-Antworten verpacken den Schlaf in dailySleepDTO.
		const s = raw.dailySleepDTO ? obj(raw.dailySleepDTO) : raw;
		add(s.calendarDate, fromSleep(s));
	}
	for (const h of list(obj(input.hrv).hrvSummaries)) add(h.calendarDate, fromHrv(h));

	return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
