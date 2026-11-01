-- Phase 1: Nutzer, Aktivitäten, Runden und Tageswerte.
-- Jede Datentabelle trägt user_id, damit später mehrere Nutzer möglich sind.

CREATE TABLE users (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	github_login TEXT NOT NULL UNIQUE,
	display_name TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	-- Ältestes Datum, bis zu dem Tageswerte bereits nachgeladen sind (YYYY-MM-DD).
	health_backfilled_to TEXT,
	-- Zeitpunkt des letzten erfolgreichen Abgleichs (ISO 8601).
	last_sync_at TEXT,
	last_sync_error TEXT
);

CREATE TABLE activities (
	user_id INTEGER NOT NULL REFERENCES users(id),
	activity_id INTEGER NOT NULL,
	name TEXT,
	type_key TEXT,
	start_time_local TEXT,
	start_time_gmt TEXT,
	duration_s REAL,
	moving_duration_s REAL,
	distance_m REAL,
	elevation_gain_m REAL,
	elevation_loss_m REAL,
	avg_speed_mps REAL,
	max_speed_mps REAL,
	avg_hr REAL,
	max_hr REAL,
	calories REAL,
	avg_power REAL,
	norm_power REAL,
	avg_cadence REAL,
	aerobic_te REAL,
	anaerobic_te REAL,
	training_load REAL,
	vo2max REAL,
	-- Sekunden in HF-Zone 1–5 als JSON-Array.
	hr_zones_s TEXT,
	lap_count INTEGER,
	-- Schlüssel der rohen FIT-Datei in R2; NULL = noch nicht geladen.
	fit_r2_key TEXT,
	fit_error TEXT,
	-- Vollständige Garmin-Zusammenfassung für spätere Auswertungen.
	summary_json TEXT,
	updated_at TEXT NOT NULL DEFAULT (datetime('now')),
	PRIMARY KEY (user_id, activity_id)
);
CREATE INDEX idx_activities_user_start ON activities(user_id, start_time_gmt DESC);
CREATE INDEX idx_activities_pending_fit ON activities(user_id) WHERE fit_r2_key IS NULL AND fit_error IS NULL;

CREATE TABLE laps (
	user_id INTEGER NOT NULL REFERENCES users(id),
	activity_id INTEGER NOT NULL,
	lap_index INTEGER NOT NULL,
	start_time TEXT,
	elapsed_s REAL,
	timer_s REAL,
	distance_m REAL,
	avg_speed_mps REAL,
	max_speed_mps REAL,
	avg_hr REAL,
	max_hr REAL,
	avg_cadence REAL,
	avg_power REAL,
	ascent_m REAL,
	descent_m REAL,
	calories REAL,
	lap_trigger TEXT,
	PRIMARY KEY (user_id, activity_id, lap_index)
);

CREATE TABLE daily_health (
	user_id INTEGER NOT NULL REFERENCES users(id),
	date TEXT NOT NULL,
	steps INTEGER,
	step_goal INTEGER,
	distance_m REAL,
	floors_up REAL,
	total_kcal INTEGER,
	active_kcal INTEGER,
	resting_hr INTEGER,
	min_hr INTEGER,
	max_hr INTEGER,
	intensity_min_moderate INTEGER,
	intensity_min_vigorous INTEGER,
	stress_avg INTEGER,
	stress_max INTEGER,
	body_battery_max INTEGER,
	body_battery_min INTEGER,
	body_battery_charged INTEGER,
	body_battery_drained INTEGER,
	respiration_avg INTEGER,
	spo2_avg INTEGER,
	sleep_s INTEGER,
	sleep_deep_s INTEGER,
	sleep_light_s INTEGER,
	sleep_rem_s INTEGER,
	sleep_awake_s INTEGER,
	sleep_score INTEGER,
	sleep_avg_hr REAL,
	hrv_last_night_avg INTEGER,
	hrv_weekly_avg INTEGER,
	hrv_status TEXT,
	updated_at TEXT NOT NULL DEFAULT (datetime('now')),
	PRIMARY KEY (user_id, date)
);
