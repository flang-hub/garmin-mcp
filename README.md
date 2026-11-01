# Garmin MCP

Remote-MCP-Server auf Cloudflare Workers, der deine Garmin-Connect-Daten für Claude bereitstellt.

- **Anmeldung:** GitHub-OAuth (Basis: Cloudflare-Vorlage [`remote-mcp-github-oauth`](https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-github-oauth)), nur freigeschaltete Konten
- **Datenquelle:** [Garmin Connect Personal API](https://developer.garmin.com/gc-developer-program/personal/personal-api/), nur lesend
- **Speicher:** D1 für Kennzahlen, R2 für die rohen FIT-Dateien
- **Abgleich:** Cron alle 30 Minuten
- **Deployment:** GitHub Actions bei jedem Push auf `main`

```
Claude ──MCP/OAuth──▶ Worker (/mcp) ──▶ D1 (users, activities, laps, daily_health)
                         ▲
        Cron */30 ──▶ Sync ──▶ Garmin Personal API ──▶ R2 (fit/<user_id>/<activity_id>.fit)
```

## MCP-Werkzeuge

| Werkzeug | Liefert |
|---|---|
| `get_recent_activities` | Aktivitäten der letzten N Tage (Standard 14), optional nach Typ gefiltert: Distanz, Dauer, Pace bzw. Tempo, Puls, Trainingslast, aerober Trainingseffekt |
| `get_activity_detail` | Eine Aktivität mit allen Kennzahlen, Minuten pro HF-Zone und Runden aus der FIT-Datei |
| `get_daily_health` | Tageswerte für einen Zeitraum (Standard 7 Tage, höchstens 92) plus Mittelwerte: Schritte, Ruhepuls, HRV, Schlaf (Dauer, Phasen, Score), Body Battery, Stress, Intensitätsminuten |

Die Werkzeuge geben kompakte, gerundete Kennzahlen zurück, keine Rohdaten. Jede Abfrage ist auf die `user_id` des angemeldeten Nutzers beschränkt.

## Einrichtung

### Voraussetzungen

- Node.js 22 oder neuer (`node -v`)
- Ein Cloudflare-Konto. Empfohlen ist **Workers Paid** (5 $/Monat), denn der Free-Plan erlaubt nur 10 ms CPU pro Aufruf, und das Auslesen einer FIT-Datei braucht mehr. R2 muss im Dashboard einmal aktiviert werden.
- Ein Garmin-Connect-Konto

### 1. Pakete installieren und bei Cloudflare anmelden

```bash
npm install
npx wrangler login
```

### 2. Cloudflare-Ressourcen anlegen

```bash
npx wrangler kv namespace create OAUTH_KV
npx wrangler d1 create garmin
npx wrangler r2 bucket create garmin-fit
```

Trage die ausgegebenen IDs in `wrangler.jsonc` ein (`<KV-ID-eintragen>` und `<D1-ID-eintragen>`). Die IDs sind nicht geheim und dürfen ins Repo.

### 3. Datenbank-Schema anlegen

```bash
npm run db:migrate:remote
```

### 4. Garmin-Personal-API-Schlüssel erstellen

1. Öffne [connect.garmin.com/app/settings/personalApiToken](https://connect.garmin.com/app/settings/personalApiToken).
2. Erstelle einen Schlüssel und wähle eine Laufzeit (30 Tage bis 1 Jahr). Garmin zeigt ihn **nur einmal** an.
3. Speichere ihn direkt als Secret (siehe Schritt 6) und nirgends sonst.

### 5. GitHub-OAuth-App erstellen

Unter [github.com/settings/developers](https://github.com/settings/developers) → **New OAuth App**:

- **Homepage URL:** `https://garmin-mcp.<dein-subdomain>.workers.dev`
- **Authorization callback URL:** `https://garmin-mcp.<dein-subdomain>.workers.dev/callback`

Notiere die Client-ID und erzeuge ein Client-Secret. Deine workers.dev-Subdomain steht im Cloudflare-Dashboard unter *Workers & Pages*.

### 6. Secrets setzen

Secrets werden nur über Wrangler gesetzt und stehen nie im Code:

```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY   # z. B. Ausgabe von: openssl rand -hex 32
npx wrangler secret put GARMIN_API_KEY
```

Beim ersten Secret fragt Wrangler, ob der Worker angelegt werden soll. Bestätige mit „Y“.

### 7. Konfiguration prüfen und erstes Deployment

Setze in `wrangler.jsonc`:

- `MCP_RESOURCE` auf `https://garmin-mcp.<dein-subdomain>.workers.dev/mcp`
- `ALLOWED_GITHUB_LOGINS` auf die GitHub-Konten, die sich anmelden dürfen (kommagetrennt)
- `GARMIN_OWNER_LOGIN` auf das GitHub-Konto, dem der Garmin-Schlüssel gehört
- optional `TIMEZONE`, `BACKFILL_DAYS` und `FIT_PER_RUN`

Dann:

```bash
npx wrangler deploy
```

Der erste Cron-Lauf startet innerhalb von 30 Minuten. Die letzten 30 Tage werden schrittweise über mehrere Läufe nachgeladen: Tageswerte in 7-Tage-Blöcken, FIT-Dateien zu höchstens `FIT_PER_RUN` pro Lauf. Die Logs siehst du mit `npx wrangler tail` oder im Dashboard unter *Observability*.

### 8. Automatisches Deployment über GitHub

Der Workflow [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) führt bei jedem Pull Request Typecheck und Tests aus. Bei jedem Push auf `main` wendet er zusätzlich neue D1-Migrationen an und deployt.

Lege dafür unter *GitHub → Repo → Settings → Secrets and variables → Actions* zwei Secrets an:

- `CLOUDFLARE_ACCOUNT_ID`: steht im Cloudflare-Dashboard rechts auf der Übersichtsseite
- `CLOUDFLARE_API_TOKEN`: Erstelle ihn unter *My Profile → API Tokens* aus der Vorlage **„Edit Cloudflare Workers“** und füge die Berechtigung **Account → D1 → Edit** hinzu (nötig für die Migrationen)

## Connector in Claude hinzufügen

**Claude (Web, Desktop, Mobile):**

1. *Einstellungen → Connectors → Benutzerdefinierten Connector hinzufügen*
2. Name: `Garmin`, URL: `https://garmin-mcp.<dein-subdomain>.workers.dev/mcp`
3. **Verbinden** → Zugriff auf der Seite „Garmin MCP“ freigeben → mit GitHub anmelden
4. Im Chat den Connector über das Werkzeug-Menü aktivieren und z. B. fragen: *„Wie war meine Trainingswoche?“*

Benutzerdefinierte Connectors gibt es in den Plänen Pro, Max, Team und Enterprise. In Team und Enterprise muss sie ein Admin freigeben.

**Claude Code:**

```bash
claude mcp add --transport http garmin https://garmin-mcp.<dein-subdomain>.workers.dev/mcp
```

Danach in Claude Code `/mcp` aufrufen und die Anmeldung abschließen.

## Lokale Entwicklung

```bash
cp .dev.vars.example .dev.vars    # Werte eintragen; .dev.vars ist in .gitignore
npm run db:migrate:local
npm run dev                       # http://localhost:8788/mcp
npm run type-check
npm test
```

Für die lokale GitHub-Anmeldung brauchst du eine zweite OAuth-App mit der Callback-URL `http://localhost:8788/callback`. Den Cron kannst du lokal mit `npx wrangler dev --test-scheduled` starten und dann `curl "http://localhost:8788/__scheduled?cron=*/30+*+*+*+*"` aufrufen. Willst du gegen einen Mock statt gegen Garmin testen, starte mit `--var GARMIN_BASE_URL:http://localhost:<port>`.

## Datenmodell

| Tabelle | Schlüssel | Inhalt |
|---|---|---|
| `users` | `id` | GitHub-Login, Stand des Abgleichs (`last_sync_at`, `last_sync_error`, `health_backfilled_to`) |
| `activities` | `user_id, activity_id` | Kennzahlen der Aktivität, `fit_r2_key` und die vollständige Garmin-Zusammenfassung (`summary_json`) für spätere Auswertungen |
| `laps` | `user_id, activity_id, lap_index` | Runden aus der FIT-Datei |
| `daily_health` | `user_id, date` | Tageswerte aus Tageszusammenfassung, Schlaf und HRV |

Schemaänderungen kommen als neue Datei nach `migrations/` (z. B. `0002_….sql`). Der Workflow wendet sie beim Deployment an.

## Hinweise und Grenzen

- **Token:** Der Garmin-Schlüssel wird gegen ein JWT getauscht, das 24 h gilt. Es liegt im KV-Namespace und wird erneuert, sobald weniger als eine Stunde übrig ist oder Garmin mit 401 antwortet. Einen Refresh-Token gibt es nicht.
- **Ablauf des Schlüssels:** Garmin mailt etwa eine Woche vorher. Neuen Schlüssel erstellen und mit `npx wrangler secret put GARMIN_API_KEY` ersetzen. Abgleichfehler stehen in `users.last_sync_error`, und die Werkzeuge zeigen sie an.
- **Runden:** Die Personal API hat keinen eigenen Runden-Endpunkt. Die Runden werden deshalb mit Garmins offiziellem [FIT JavaScript SDK](https://www.npmjs.com/package/@garmin/fitsdk) aus der Originaldatei gelesen. Aktivitäten ohne FIT-Datei (z. B. manuell erfasste) bekommen einen Vermerk in `fit_error` und werden nicht erneut versucht.
- **Rate-Limits** dokumentiert Garmin nicht. Der Abgleich hält die Zahl der Aufrufe daher bewusst klein: pro Lauf etwa 8 Aufrufe plus höchstens `FIT_PER_RUN` Downloads.
- **Mehrere Nutzer:** Alle Tabellen tragen bereits eine `user_id`. In Phase 1 gehört der einzige Garmin-Schlüssel `GARMIN_OWNER_LOGIN`. Beachte: Laut Garmin-FAQ ist die Personal API für die eigenen Daten gedacht und *nicht* für kommerzielle Anwendungen mit mehreren Nutzern. Für fremde Konten wäre das [Garmin Connect Developer Program](https://developer.garmin.com/gc-developer-program/) der richtige Weg.
