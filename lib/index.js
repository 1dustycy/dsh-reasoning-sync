/**
 * Host half of `dsh-reasoning-sync`.
 *
 * The plugin's own work is one operation (`lib/sync.js`): resolve the route's
 * credential, read the endpoint catalog, plan (`lib/plan.js`), and write the
 * difference through the settings service. This module is the thin adapter that
 * puts that operation in front of its caller — the Models settings page, through
 * two Connection Fetch routes (`lib/routes.js`).
 *
 * **Why a Fetch route and not an agent tool.** The operation is maintenance on
 * one's own configuration: it has a page it belongs to, a person reading the
 * difference, and a button whose result the person confirms. Handing it to the
 * model instead would add a tool to every request's schema and let a turn rewrite
 * configuration on its own initiative, in exchange for a trigger a bookmarked
 * settings page already provides. ADR-0006 records the reversal of the spec's
 * stories 21 and 22.
 *
 * Two other rules hold here. Services are resolved **per call**, never captured:
 * this plugin is mounted in a profile whose other entries load around it, so
 * binding a service while `apply` runs would freeze its absence for the life of
 * the plugin. And the plugin imports nothing outside `node:` and its own files —
 * a profile's `node_modules` holds only profile-installed bundles, so a bare
 * import of an application package would fail to resolve at load.
 *
 * @module dsh-reasoning-sync
 */

import { ROUTES_ROUTE, SYNC_ROUTE, routesResponse, syncResponse, syncableRoutes } from "./routes.js";
import { createReasoningSync } from "./sync.js";

/** Cordis plugin name used by Loader diagnostics. */
export const name = "reasoning-sync";

/**
 * The sync operation wired to the live profile.
 *
 * Settings and credentials are read through `ctx.get` on every call, so a
 * profile that gains (or loses) the credentials service keeps working, and a
 * missing settings service surfaces as this plugin's own `unavailable` failure
 * rather than an exception out of the route.
 * @param ctx - plugin context.
 * @returns the operation, `(input) => Promise<result>`.
 */
function operation(ctx) {
	return (input) => createReasoningSync({
		settings: ctx.get("settings"),
		credentials: ctx.get("credentials"),
		request: (...args) => globalThis.fetch(...args)
	}).run(input);
}

/**
 * Answer which routes the plugin serves, from the live settings forms.
 * @param ctx - plugin context.
 * @returns the served routes and their namespaces; empty when there is nothing
 * to read them from, which leaves the Client half with no seat to claim.
 */
async function servedRoutes(ctx) {
	const settings = ctx.get("settings");
	if (typeof settings?.describe !== "function") return {
		namespaces: [],
		routes: []
	};
	try {
		return syncableRoutes(await settings.describe());
	} catch (error) {
		ctx.logger?.warn?.(`reasoning-sync: cannot read the settings forms: ${String(error?.message ?? error)}`);
		return {
			namespaces: [],
			routes: []
		};
	}
}

/**
 * Offer the Models settings page the two routes its card needs.
 *
 * Registration is inside Connection, so both routes sit behind the same
 * Host/Origin fence and browser session the page's every other request passes;
 * the plugin adds no channel of its own.
 * @param ctx - plugin context.
 * @param run - the sync operation.
 */
function offerRoutes(ctx, run) {
	ctx.inject(["connection"], (connectionCtx) => {
		const registry = connectionCtx.get("connection")?.fetch;
		if (registry?.register === undefined) {
			ctx.logger?.warn?.("reasoning-sync: no Connection Fetch registry; the Models card cannot reach this Host");
			return;
		}
		connectionCtx.effect(() => {
			const disposers = [];
			// A duplicate path throws, and a throw here would otherwise strand the
			// route registered just before it: each registration is offered on its
			// own, and a refused one only costs the card its route.
			const offer = (path, route) => {
				try {
					disposers.push(registry.register({
						path,
						...route
					}));
				} catch (error) {
					ctx.logger?.warn?.(`reasoning-sync: cannot register ${path}: ${String(error?.message ?? error)}`);
				}
			};
			offer(SYNC_ROUTE, {
				methods: ["POST"],
				requestBody: "buffered",
				fetch: (request) => syncResponse(request, run)
			});
			offer(ROUTES_ROUTE, {
				methods: ["GET"],
				requestBody: "buffered",
				fetch: async () => routesResponse(await servedRoutes(ctx))
			});
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, "reasoning-sync: Models card routes");
	});
}

/**
 * Host plugin body: expose the operation to the Models settings page.
 * @param ctx - the mounting composition's context.
 */
export function apply(ctx) {
	offerRoutes(ctx, operation(ctx));
}
