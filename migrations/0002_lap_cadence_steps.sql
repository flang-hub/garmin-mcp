-- Runden-Kadenz bei Schrittsportarten von Doppelschritten auf Schritte pro Minute umstellen
-- (wie Garmin Connect und die Aktivitäts-Kadenz). Betrifft nur bereits gespeicherte Runden.
UPDATE laps SET avg_cadence = avg_cadence * 2
WHERE avg_cadence IS NOT NULL
	AND EXISTS (
		SELECT 1 FROM activities a
		WHERE a.user_id = laps.user_id AND a.activity_id = laps.activity_id
			AND (a.type_key LIKE '%running%' OR a.type_key LIKE '%walking%' OR a.type_key LIKE '%hiking%')
	);
