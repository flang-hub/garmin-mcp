import { Encoder, type Mesg, Profile } from "@garmin/fitsdk";
import { describe, expect, it } from "vitest";
import { addMonths, backoffMinutes } from "../src/backfill";
import { analyzeRun, zoneOf } from "../src/garmin/analysis";
import { decodeFit } from "../src/garmin/fit";
import { paceChange, weekStart, weeksBetween } from "../src/trends";

const mesg = (fields: Record<string, unknown>) => fields as Mesg;
const BOUNDS = [98, 118, 137, 157, 176, 196];

/**
 * 40 min Lauf mit 1 Hz bei konstant 3 m/s: erste Hälfte HF 140, zweite Hälfte HF 147.
 * Nach 20 min eine Pause von 60 s (keine Datenpunkte), nach 10 min ein Anstieg um 5 m.
 */
function syntheticRun(): Uint8Array {
	const enc = new Encoder();
	const t0 = Date.parse("2026-10-30T07:00:00Z");
	enc.onMesg(Profile.MesgNum.FILE_ID, mesg({ type: "activity", manufacturer: "garmin", timeCreated: new Date(t0) }));
	let d = 0;
	// 2402 Punkte: 2400 Bewegungssekunden plus der Abschnitt über die Pause, der nicht zählt.
	for (let i = 0; i <= 2401; i++) {
		const paused = i > 1200 ? 60 : 0;
		// Während der Pause bewegt sich die Uhr nicht: Distanz bleibt gleich.
		if (i === 1201) d -= 3;
		enc.onMesg(
			Profile.MesgNum.RECORD,
			mesg({
				timestamp: new Date(t0 + (i + paused) * 1000),
				distance: d,
				enhancedSpeed: 3,
				heartRate: i < 1200 ? 140 : 147,
				enhancedAltitude: i < 600 ? 100 : 105,
			}),
		);
		d += 3;
	}
	enc.onMesg(
		Profile.MesgNum.TIME_IN_ZONE,
		mesg({
			timestamp: new Date(t0 + 2460_000),
			referenceMesg: "session",
			referenceIndex: 0,
			hrZoneHighBoundary: BOUNDS,
			hrCalcType: "percentMaxHr",
			timeInHrZone: [0, 0, 0, 2400, 0, 0, 0],
		}),
	);
	enc.onMesg(Profile.MesgNum.SESSION, mesg({ timestamp: new Date(t0 + 2460_000), sport: "running" }));
	return enc.close();
}

describe("Laufauswertung", () => {
	const m = analyzeRun(decodeFit(syntheticRun()));

	it("rechnet Bewegungszeit und Distanz ohne die Pause", () => {
		expect(m.moving_s).toBe(2400);
		expect(m.distance_m).toBe(7200);
	});

	it("bildet Kilometer-Splits mit Restkilometer", () => {
		expect(m.splits).toHaveLength(8);
		expect(m.splits[0]).toMatchObject({ km: 1, distance_m: 1000, avg_hr: 140, ascent_m: 0 });
		// Der Anstieg nach 10 min (bei 1800 m) fällt in den zweiten Kilometer.
		expect(m.splits[1]).toMatchObject({ km: 2, ascent_m: 5, descent_m: 0 });
		expect(m.splits[0].time_s).toBeCloseTo(333.3, 1);
		expect(m.splits[7]).toMatchObject({ km: 8, distance_m: 200, avg_hr: 147 });
		// Gleichmäßiges Tempo → keine Streuung.
		expect(m.pace_cv_pct).toBe(0);
	});

	it("berechnet die HF-Drift aus beiden Hälften", () => {
		// Gleiches Tempo, Puls 140 → 147: (1 − 140/147) = 4,8 %
		expect(m.hr_drift_pct).toBe(4.8);
	});

	it("übernimmt die Garmin-Zonen und rechnet Meter pro Zone", () => {
		expect(m.zone_bounds).toEqual(BOUNDS);
		expect(m.zone_s).toEqual([0, 0, 0, 2400, 0, 0]);
		expect(m.zone_moving_s?.[3]).toBe(2400);
		expect(m.zone_m?.[3]).toBe(7200);
	});

	it("sammelt Zeit und Meter in 5-bpm-Stufen", () => {
		expect(m.hr_bins).toEqual([
			{ bpm_low: 140, seconds: 1200, meters: 3600 },
			{ bpm_low: 145, seconds: 1200, meters: 3600 },
		]);
	});

	it("ordnet den Grenzwert wie Garmin der höheren Zone zu", () => {
		expect(zoneOf(117, BOUNDS)).toBe(1);
		expect(zoneOf(118, BOUNDS)).toBe(2);
		expect(zoneOf(137, BOUNDS)).toBe(3);
		expect(zoneOf(90, BOUNDS)).toBe(0);
		expect(zoneOf(200, BOUNDS)).toBe(5);
	});
});

describe("Backfill-Hilfen", () => {
	it("rechnet Monate über Monatsenden", () => {
		expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
		expect(addMonths("2026-11-02", -24)).toBe("2024-11-02");
	});

	it("verdoppelt die Wartezeit bis höchstens 12 h", () => {
		expect([1, 2, 3, 10].map(backoffMinutes)).toEqual([30, 60, 120, 720]);
	});
});

describe("Trend-Text", () => {
	it("beschreibt die Pace-Veränderung", () => {
		expect(paceChange(420, 400)).toBe("schneller um 0:20 min/km");
		expect(paceChange(400, 405)).toBe("langsamer um 0:05 min/km");
		expect(paceChange(400, 400.3)).toBe("unverändert");
	});
});

describe("Wochen", () => {
	it("beginnen montags", () => {
		expect(weekStart("2026-11-01")).toBe("2026-10-26"); // Sonntag
		expect(weekStart("2026-10-26")).toBe("2026-10-26"); // Montag
		expect(weeksBetween("2026-10-14", "2026-11-01")).toEqual(["2026-10-12", "2026-10-19", "2026-10-26"]);
	});
});
