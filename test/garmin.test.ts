import { Encoder, type Mesg, Profile } from "@garmin/fitsdk";
import { zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { addDays, localDate } from "../src/dates";
import { activityDetail, activitySummary, dailyHealth, formatDuration, speedFields } from "../src/format";
import { type CachedToken, GarminClient, jwtExpiration } from "../src/garmin/client";
import { decodeFit, extractFit, parseLaps } from "../src/garmin/fit";
import { mergeDailyHealth, toActivityRow } from "../src/garmin/mapping";

const fakeJwt = (exp: number) => `x.${btoa(JSON.stringify({ exp })).replace(/=+$/, "")}.y`;

function memoryCache(initial: CachedToken | null = null) {
	let value = initial;
	return { get: async () => value, put: async (t: CachedToken) => void (value = t), peek: () => value };
}

describe("GarminClient", () => {
	const now = 1_800_000_000;

	it("liest exp aus dem JWT", () => {
		expect(jwtExpiration(fakeJwt(now))).toBe(now);
	});

	it("tauscht den Schlüssel gegen ein Token und nutzt es danach weiter", async () => {
		const token = fakeJwt(now + 86_400);
		const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			if (String(url).includes("/token")) {
				expect(new Headers(init?.headers).get("Authorization")).toBe("ApiKey geheim");
				expect(init?.method).toBe("POST");
				return new Response(token);
			}
			expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${token}`);
			return Response.json([]);
		});
		const cache = memoryCache();
		const client = new GarminClient("geheim", cache, fetchFn as typeof fetch, () => now);
		await client.searchActivities({ start: 0, limit: 1 });
		await client.searchActivities({ start: 0, limit: 1 });
		expect(fetchFn.mock.calls.filter(([u]) => String(u).includes("/token"))).toHaveLength(1);
		expect(cache.peek()?.expiresAt).toBe(now + 86_400);
	});

	it("erneuert ein Token, das in weniger als einer Stunde abläuft", async () => {
		const fetchFn = vi.fn(async (url: string | URL | Request) =>
			String(url).includes("/token") ? new Response(fakeJwt(now + 86_400)) : Response.json([]),
		);
		const cache = memoryCache({ accessToken: "alt", expiresAt: now + 1800 });
		await new GarminClient("k", cache, fetchFn as typeof fetch, () => now).searchActivities({ start: 0, limit: 1 });
		expect(fetchFn.mock.calls[0][0]).toContain("/token");
	});

	it("holt bei 401 einmal ein neues Token und wiederholt die Anfrage", async () => {
		let dataCalls = 0;
		const fetchFn = vi.fn(async (url: string | URL | Request) => {
			if (String(url).includes("/token")) return new Response(fakeJwt(now + 86_400));
			return ++dataCalls === 1 ? new Response("expired", { status: 401 }) : Response.json([{ activityId: 1 }]);
		});
		const cache = memoryCache({ accessToken: "widerrufen", expiresAt: now + 80_000 });
		const result = await new GarminClient("k", cache, fetchFn as typeof fetch, () => now).searchActivities({
			start: 0,
			limit: 1,
		});
		expect(result).toEqual([{ activityId: 1 }]);
		expect(dataCalls).toBe(2);
	});
});

// Die SDK-Typen erwarten Zahlen für Enums; der Encoder akzeptiert auch die Namen.
const mesg = (fields: Record<string, unknown>) => fields as Mesg;

function buildFit(sport = "running"): Uint8Array {
	const enc = new Encoder();
	const start = new Date("2026-10-30T07:00:00Z");
	enc.onMesg(Profile.MesgNum.FILE_ID, mesg({ type: "activity", manufacturer: "garmin", timeCreated: start }));
	for (let i = 0; i < 2; i++) {
		enc.onMesg(
			Profile.MesgNum.LAP,
			mesg({
			messageIndex: i,
			startTime: new Date(start.getTime() + i * 300_000),
			timestamp: new Date(start.getTime() + (i + 1) * 300_000),
			totalElapsedTime: 300,
			totalTimerTime: 295,
			totalDistance: 1000,
			enhancedAvgSpeed: 1000 / 295,
			avgHeartRate: 150 + i,
			maxHeartRate: 165,
			sport,
			avgCadence: 85,
			avgFractionalCadence: 0.5,
			totalAscent: 12,
			lapTrigger: "distance",
			}),
		);
	}
	return enc.close();
}

describe("FIT", () => {
	it("holt die FIT-Datei aus dem ZIP und liest die Runden", () => {
		const fit = buildFit();
		const zip = zipSync({ "123_ACTIVITY.fit": fit });
		const extracted = extractFit(zip);
		expect(extracted).toEqual(fit);
		const laps = parseLaps(decodeFit(extracted));
		expect(laps).toHaveLength(2);
		expect(laps[1]).toMatchObject({
			lap_index: 1,
			start_time: "2026-10-30T07:05:00.000Z",
			distance_m: 1000,
			timer_s: 295,
			avg_hr: 151,
			max_hr: 165,
			// 85,5 Doppelschritte → 171 Schritte pro Minute
			avg_cadence: 171,
			ascent_m: 12,
			lap_trigger: "distance",
		});
		expect(laps[1].avg_speed_mps).toBeCloseTo(3.39, 2);
	});

	it("lässt die Kadenz bei Nicht-Schrittsportarten unverändert", () => {
		expect(parseLaps(decodeFit(buildFit("cycling")))[0].avg_cadence).toBe(85);
	});

	it("akzeptiert eine FIT-Datei ohne ZIP", () => {
		const fit = buildFit();
		expect(extractFit(fit)).toBe(fit);
	});

	it("meldet ein ZIP ohne FIT-Datei", () => {
		expect(() => extractFit(zipSync({ "a.gpx": new Uint8Array([1]) }))).toThrow(/Keine FIT-Datei/);
	});
});

describe("Mapping", () => {
	it("übernimmt die Kennzahlen einer Aktivität", () => {
		const row = toActivityRow({
			activityId: 42,
			activityName: "Morgenlauf",
			activityType: { typeKey: "running" },
			startTimeLocal: "2026-10-30 08:00:00",
			distance: 10_000,
			duration: 3000,
			averageSpeed: 10_000 / 3000,
			averageHR: 148,
			averageRunningCadenceInStepsPerMinute: 172,
			activityTrainingLoad: 120.4,
			hrTimeInZone_1: 60,
			hrTimeInZone_3: 1800,
		});
		expect(row).toMatchObject({ activity_id: 42, type_key: "running", avg_cadence: 172, training_load: 120.4 });
		expect(JSON.parse(row!.hr_zones_s!)).toEqual([60, null, 1800, null, null]);
		expect(toActivityRow({ activityName: "ohne ID" })).toBeNull();
	});

	it("führt Tageszusammenfassung, Schlaf und HRV pro Tag zusammen", () => {
		const rows = mergeDailyHealth({
			summaries: {
				data: [
					{
						calendarDate: "2026-10-30",
						movement: { steps: { value: 9000, goal: 8000, distanceInMeters: 7000 } },
						heartRate: { restingValue: 48 },
						stress: { avgLevel: -1, maxLevel: 80 },
						bodyBattery: { maxValue: 90, minValue: 20 },
					},
				],
			},
			sleep: [{ calendarDate: "2026-10-30", sleepTimeSeconds: 27_000, sleepScores: { overall: { value: 82 } } }],
			hrv: { hrvSummaries: [{ calendarDate: "2026-10-31", lastNightAvg: 61, status: "BALANCED" }] },
		});
		expect(rows.map((r) => r.date)).toEqual(["2026-10-30", "2026-10-31"]);
		expect(rows[0]).toMatchObject({ steps: 9000, resting_hr: 48, stress_avg: null, stress_max: 80, sleep_score: 82 });
		expect(rows[1]).toMatchObject({ hrv_last_night_avg: 61, hrv_status: "BALANCED" });
	});
});

describe("Format", () => {
	it("formatiert Dauer und Pace", () => {
		expect(formatDuration(3725)).toBe("1:02:05");
		expect(formatDuration(295)).toBe("4:55");
		expect(speedFields("trail_running", 1000 / 300)).toEqual({ pace_min_per_km: "5:00" });
		expect(speedFields("lap_swimming", 1)).toEqual({ pace_min_per_100m: "1:40" });
		expect(speedFields("road_biking", 10)).toEqual({ speed_kmh: 36 });
	});

	it("liefert kompakte Aktivitäten ohne leere Felder", () => {
		const a = { activity_id: 1, type_key: "running", distance_m: 10_000, duration_s: 3000, avg_speed_mps: 10 / 3, avg_hr: null };
		expect(activitySummary(a)).toEqual({
			activity_id: 1,
			type: "running",
			distance_km: 10,
			duration: "50:00",
			pace_min_per_km: "5:00",
		});
		const detail = activityDetail({ ...a, hr_zones_s: "[60,null,1800,null,null]", fit_r2_key: null }, []);
		expect(detail.hr_zone_minutes).toEqual([1, 0, 30, 0, 0]);
		expect(detail.laps_status).toBe("Runden werden noch geladen");
	});

	it("rechnet Schlaf in Stunden um", () => {
		expect(dailyHealth({ date: "2026-10-30", sleep_s: 27_000, steps: 9000 })).toEqual({
			date: "2026-10-30",
			steps: 9000,
			sleep_h: 7.5,
		});
	});
});

describe("Datum", () => {
	it("rechnet in der lokalen Zeitzone", () => {
		// 23:30 UTC am 31.10. ist in Berlin (MEZ) schon der 1.11.
		expect(localDate("Europe/Berlin", new Date("2026-10-31T23:30:00Z"))).toBe("2026-11-01");
		expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
	});
});
