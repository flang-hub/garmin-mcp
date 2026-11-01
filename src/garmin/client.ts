/**
 * Minimaler Client für die Garmin Connect Personal API (nur lesend).
 *
 * Ablauf laut Garmin-FAQ und dem offiziellen Python-Client:
 * - Der Personal-API-Schlüssel wird per POST gegen ein JWT getauscht (24 h gültig).
 * - Es gibt keinen Refresh-Token; ein neues Token holt man wieder mit dem Schlüssel.
 * - Wie der Python-Client erneuern wir, sobald weniger als eine Stunde übrig ist.
 */

export const GARMIN_BASE_URL = "https://personal.connectapi.garmin.com";
const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";
const REFRESH_WINDOW_S = 60 * 60;

export type CachedToken = { accessToken: string; expiresAt: number };

export interface TokenCache {
	get(): Promise<CachedToken | null>;
	put(token: CachedToken): Promise<void>;
}

export class GarminApiError extends Error {
	constructor(
		readonly status: number,
		readonly path: string,
		body: string,
	) {
		// Antworttext kürzen, damit keine großen Fehlerseiten in Logs landen.
		super(`Garmin API ${status} für ${path}: ${body.slice(0, 200)}`);
	}
}

/** Liest den exp-Claim eines JWT, ohne die Signatur zu prüfen. */
export function jwtExpiration(token: string): number {
	const payload = token.split(".")[1];
	if (!payload) throw new Error("Garmin-Token ist kein JWT");
	const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "="));
	const exp = Number(JSON.parse(json).exp);
	if (!Number.isFinite(exp)) throw new Error("Garmin-Token hat keinen exp-Claim");
	return exp;
}

export class GarminClient {
	private token: CachedToken | null = null;

	constructor(
		private readonly apiKey: string,
		private readonly cache: TokenCache,
		// fetch nicht als Methode aufrufen, sonst wirft Workers "Illegal invocation".
		private readonly fetchFn: typeof fetch = (input, init) => fetch(input, init),
		private readonly now: () => number = () => Date.now() / 1000,
		// Nur für lokale Tests gegen einen Mock-Server, wie GARMIN_PERSONAL_API_BASE_URL im Python-Client.
		private readonly baseUrl: string = GARMIN_BASE_URL,
	) {}

	private isFresh(token: CachedToken | null): token is CachedToken {
		return token !== null && token.expiresAt - this.now() > REFRESH_WINDOW_S;
	}

	async accessToken(forceRefresh = false): Promise<string> {
		if (!forceRefresh) {
			if (this.isFresh(this.token)) return this.token.accessToken;
			const cached = await this.cache.get();
			if (this.isFresh(cached)) {
				this.token = cached;
				return cached.accessToken;
			}
		}
		const res = await this.fetchFn(this.baseUrl + TOKEN_PATH, {
			method: "POST",
			headers: { Accept: "*/*", Authorization: `ApiKey ${this.apiKey}` },
		});
		if (!res.ok) throw new GarminApiError(res.status, TOKEN_PATH, await res.text());
		const accessToken = (await res.text()).trim();
		this.token = { accessToken, expiresAt: jwtExpiration(accessToken) };
		await this.cache.put(this.token);
		return accessToken;
	}

	/** Authentifizierter GET; bei 401 wird das Token einmal neu geholt. */
	private async request(path: string, params: Record<string, string | number> = {}, accept = "application/json") {
		const url = new URL(this.baseUrl + path);
		for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
		const send = async (force: boolean) =>
			this.fetchFn(url.toString(), {
				headers: { Accept: accept, Authorization: `Bearer ${await this.accessToken(force)}` },
			});
		let res = await send(false);
		if (res.status === 401) res = await send(true);
		if (!res.ok) throw new GarminApiError(res.status, path, await res.text());
		return res;
	}

	async getJson<T = unknown>(path: string, params?: Record<string, string | number>): Promise<T | null> {
		const res = await this.request(path, params);
		const text = await res.text();
		return text ? (JSON.parse(text) as T) : null;
	}

	searchActivities(params: { start: number; limit: number; startDate?: string; endDate?: string }) {
		return this.getJson<Record<string, unknown>[]>("/activitylist-service/activities/search/activities", params);
	}

	dailySummaries(startDate: string, endDate: string) {
		return this.getJson<{ data?: Record<string, unknown>[] }>("/usersummary-service/v2/dailysummaries", {
			startDate,
			endDate,
		});
	}

	sleepSummaries(startDate: string, endDate: string) {
		return this.getJson<Record<string, unknown>[]>("/sleep-service/sleep/dailySleepSummariesByDate", {
			startDate,
			endDate,
		});
	}

	hrvSummaries(startDate: string, endDate: string) {
		return this.getJson<{ hrvSummaries?: Record<string, unknown>[] }>(`/hrv-service/hrv/daily/${startDate}/${endDate}`);
	}

	/** Liefert die Originaldatei der Aktivität als ZIP (laut Swagger application/x-zip-compressed). */
	async downloadActivity(activityId: number): Promise<Uint8Array> {
		const res = await this.request(`/download-service/files/activity/${activityId}`, {}, "*/*");
		return new Uint8Array(await res.arrayBuffer());
	}
}
