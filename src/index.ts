import { env } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { GitHubHandler } from "./auth/github-handler";
import type { Props } from "./auth/utils";
import { runBackfill } from "./backfill";
import { runScheduledSync } from "./sync";
import { registerGarminTools } from "./tools";

function createServer() {
	const server = new McpServer({ name: "Garmin Connect", version: "0.1.0" });
	const props = getMcpAuthContext()?.props as Props | undefined;
	// Ohne Anmeldung gibt es keine Werkzeuge; die OAuth-Schicht lässt ohnehin nur gültige Tokens durch.
	if (props) registerGarminTools(server, env, props.userId);
	return server;
}

const mcpHandler = createMcpHandler(createServer);
const apiHandler = {
	fetch(request: Request, bindings: Env, ctx: ExecutionContext) {
		return mcpHandler(request, bindings, ctx);
	},
} satisfies ExportedHandler<Env>;

const oauthProvider = new OAuthProvider<Env>({
	apiHandler,
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as any,
	tokenEndpoint: "/token",
	// Die URL, mit der sich MCP-Clients verbinden. Jedes Token ist an sie gebunden.
	resourceMetadata: { resource: env.MCP_RESOURCE },
});

const BACKFILL_CRON = "5-59/10 * * * *";

export default {
	fetch: (request, bindings, ctx) => oauthProvider.fetch(request, bindings, ctx),
	// Cron-Trigger (siehe wrangler.jsonc): alle 30 Minuten der Abgleich, dazwischen der Historien-Backfill.
	scheduled(controller, bindings, ctx) {
		ctx.waitUntil(controller.cron === BACKFILL_CRON ? runBackfill(bindings) : runScheduledSync(bindings));
	},
} satisfies ExportedHandler<Env>;
