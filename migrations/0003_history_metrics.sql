-- Phase 2: Backfill-Fortschritt und Kennzahlen pro Lauf.

-- Ein Eintrag pro Nutzer und Backfill-Job (activities, health, files).
CREATE TABLE backfill_jobs (
	user_id INTEGER NOT NULL REFERENCES users(id),
	job TEXT NOT NULL,
	-- Ältestes Datum, bis zu dem der Job fertig ist (YYYY-MM-DD); NULL = noch nicht begonnen.
	cursor TEXT,
	-- Zieldatum: so weit zurück soll der Job laden.
	target TEXT NOT NULL,
	done INTEGER NOT NULL DEFAULT 0,
	processed INTEGER NOT NULL DEFAULT 0,
	failures INTEGER NOT NULL DEFAULT 0,
	last_run_at TEXT,
	last_error TEXT,
	-- Nach Rate-Limit oder Fehlern erst ab diesem Zeitpunkt weitermachen (ISO 8601).
	retry_after TEXT,
	PRIMARY KEY (user_id, job)
);

-- Sperre gegen überlappende Backfill-Läufe: Ein Lauf reserviert sich bis zu diesem Zeitpunkt (ISO 8601).
ALTER TABLE users ADD COLUMN backfill_lease_until TEXT;

-- Versuchszähler für die FIT-Verarbeitung: Bricht Cloudflare einen Aufruf (CPU-Limit)
-- mehrfach ab, wird die Datei übersprungen statt endlos neu versucht.
ALTER TABLE activities ADD COLUMN fit_attempts INTEGER NOT NULL DEFAULT 0;

CREATE TABLE activity_metrics (
	user_id INTEGER NOT NULL REFERENCES users(id),
	activity_id INTEGER NOT NULL,
	metrics_version INTEGER NOT NULL,
	moving_s INTEGER,
	distance_m INTEGER,
	-- Garmin-Zonen dieses Laufs (JSON): Grenzen [z1_low, z1_high … z5_high], Berechnungsart.
	zone_bounds TEXT,
	zone_calc TEXT,
	-- Sekunden pro Zone 0–5 laut Uhr (JSON).
	zone_s TEXT,
	-- Aus den Sekundendaten: Bewegungszeit und Meter pro Zone 0–5 (JSON), für Pace pro Zone.
	zone_moving_s TEXT,
	zone_m TEXT,
	hr_drift_pct REAL,
	pace_cv_pct REAL,
	error TEXT,
	computed_at TEXT NOT NULL DEFAULT (datetime('now')),
	PRIMARY KEY (user_id, activity_id)
);

CREATE TABLE activity_splits (
	user_id INTEGER NOT NULL REFERENCES users(id),
	activity_id INTEGER NOT NULL,
	km INTEGER NOT NULL,
	distance_m INTEGER,
	time_s REAL,
	avg_hr INTEGER,
	ascent_m INTEGER,
	descent_m INTEGER,
	PRIMARY KEY (user_id, activity_id, km)
);

-- Bewegungszeit und Meter je 5-bpm-Stufe, für "Pace bei HF x–y".
CREATE TABLE activity_hr_bins (
	user_id INTEGER NOT NULL REFERENCES users(id),
	activity_id INTEGER NOT NULL,
	bpm_low INTEGER NOT NULL,
	seconds INTEGER NOT NULL,
	meters INTEGER NOT NULL,
	PRIMARY KEY (user_id, activity_id, bpm_low)
);

CREATE INDEX idx_activities_user_local ON activities(user_id, start_time_local);
