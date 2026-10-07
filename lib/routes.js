/**
 * The Host's two HTTP doors, both on the Connection Fetch registry (the same
 * `/api` fence every page request passes, with the browser session cookie and
 * the Host/Origin check already applied):
 *
 * - `GET /api/reasoning-sync.routes` answers **which provider routes this plugin
 *   serves**. The Models page renders our seat once per settings namespace, and
 *   the seat's own props carry the route's id, display name and settings address
 *   — but not its `baseURL`, which is the one thing that decides whether an
 *   endpoint publishes a catalog we can read. The page therefore cannot filter
 *   by itself, and the Host answers instead.
 * - `POST /api/reasoning-sync.sync` runs the operation (`lib/sync.js`), the same
 *   one the agent tool calls.
 *
 * Both handlers are plain Request → Response functions so the whole surface is
 * testable in a Node process (`test/routes.test.mjs`); `lib/index.js` only wires
 * them to the live services.
 *
 * @module dsh-reasoning-sync/routes
 */

/** Exact Fetch route running one sync. */
export const SYNC_ROUTE = "/api/reasoning-sync.sync";

/** Exact Fetch route answering which provider routes are syncable. */
export const ROUTES_ROUTE = "/api/reasoning-sync.routes";

/**
 * Endpoint hosts whose `GET /models` publishes the capability contract this
 * plugin maps.
 *
 * The mapping is OpenRouter's: `reasoning.supported_efforts` holds the same
 * level names the adapter declares. Another endpoint's catalog would either
 * fail to answer or answer in a vocabulary this plugin would have to guess at,
 * so a route is served only when its `baseURL` is aimed at one of these hosts —
 * that is what keeps the card off every other provider in Settings → Models
 * rather than offering a sync that cannot work.
 */
export const CATALOG_HOSTS = ["openrouter.ai"];

/**
 * Whether one route's `baseURL` points at a catalog this plugin can read.
 * @param profile - the route's profile node from the settings value.
 * @returns true when the route is served by this plugin.
 */
function servesCatalog(profile) {
	if (profile === null || typeof profile !== "object" || Array.isArray(profile)) return false;
	if (typeof profile.baseURL !== "string" || profile.baseURL === "") return false;
	let host;
	try {
		host = new URL(profile.baseURL).hostname.toLowerCase();
	} catch {
		return false;
	}
	return CATALOG_HOSTS.some((catalog) => host === catalog || host.endsWith(`.${catalog}`));
}

/**
 * Find the routes this plugin serves among the live settings forms.
 *
 * A settings descriptor is the shape the settings service returns: `{ ns,
 * revision, value }`, with `value.providers.<route>` holding each pi-ai route.
 * The namespace travels back with every route because that is the seat key the
 * Client half must register under — it is the adapter entry's own id, which a
 * profile may rename, so it is read rather than assumed.
 * @param descriptors - the settings service's `describe()` result.
 * @returns the served routes and the namespaces that hold them.
 */
export function syncableRoutes(descriptors) {
	const routes = [];
	const namespaces = [];
	for (const descriptor of Array.isArray(descriptors) ? descriptors : []) {
		const ns = descriptor?.ns;
		const providers = descriptor?.value?.providers;
		if (typeof ns !== "string" || providers === null || typeof providers !== "object" || Array.isArray(providers)) continue;
		for (const [provider, profile] of Object.entries(providers)) {
			if (!servesCatalog(profile)) continue;
			const displayName = typeof profile.displayName === "string" && profile.displayName !== "" ? profile.displayName : provider;
			routes.push({
				provider,
				displayName,
				namespace: ns
			});
			if (!namespaces.includes(ns)) namespaces.push(ns);
		}
	}
	routes.sort((left, right) => left.provider.localeCompare(right.provider));
	return {
		namespaces,
		routes
	};
}

/**
 * Answer the route list.
 * @param routes - what {@link syncableRoutes} found.
 * @returns the response the Client half reads.
 */
export function routesResponse(routes) {
	return Response.json(routes, { headers: { "cache-control": "no-store" } });
}

/**
 * Run one sync from a request body.
 *
 * A body that is not JSON is answered 400; every outcome of the operation
 * itself — including its failures — is a 200 carrying the result, because
 * "there is no credential for this route" is an answer, not a transport error.
 * The operation writes nothing unless the body asks it to apply.
 * @param request - the incoming request.
 * @param run - the sync operation, `(input) => Promise<result>`.
 * @returns the response the Client half reads.
 */
export async function syncResponse(request, run) {
	let body;
	try {
		body = await request.json();
	} catch (error) {
		return Response.json({
			ok: false,
			kind: "request",
			message: `the sync request body is not JSON: ${String(error?.message ?? error)}`
		}, { status: 400 });
	}
	return Response.json(await run({
		provider: body?.provider,
		...body?.action === void 0 ? {} : { action: body.action }
	}), { headers: { "cache-control": "no-store" } });
}
