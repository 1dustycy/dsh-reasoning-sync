/**
 * The Host plugin body: the seat it offers the Models page, and what happens in
 * a profile that cannot take it.
 *
 * `apply` is the only place that touches a Cordis context, so it is the only
 * host-side code a double has to stand in for. Everything behind the routes —
 * the operation, the plan — is covered by its own suite.
 *
 * Run with `node test/apply.test.mjs`.
 */

import assert from "node:assert/strict";
import { apply, name } from "../lib/index.js";
import { ROUTES_ROUTE, SYNC_ROUTE } from "../lib/routes.js";

let passed = 0;
const failures = [];
const cases = [];

/** Register one named test; failures are collected instead of stopping the run. */
function test(title, body) {
	cases.push({ title, body });
}

/**
 * A Cordis context double: the optional Connection service, effect lifetime,
 * and the registry the plugin registers into.
 *
 * `inject` mirrors the real loader: a service the profile does not provide
 * leaves the callback unrun — no throw, no log — and the plugin body simply
 * waits.
 * @param options - whether the profile has Connection, and how its registry behaves.
 * @returns the context plus what was registered through it.
 */
function context({ connection = true, routes = {}, failSecondRoute = false } = {}) {
	const registered = { routes: [], warnings: [], disposed: [] };
	const child = (services) => ({
		get: (key) => services[key],
		effect: (body, label) => {
			const dispose = body();
			registered.disposed.push({
				label,
				dispose
			});
			return dispose;
		}
	});
	const connectionService = {
		fetch: {
			register(route) {
				if (failSecondRoute && route.path === ROUTES_ROUTE) throw new Error(`connection: exact Fetch route "${route.path}" is already registered`);
				registered.routes.push(route);
				return () => registered.routes.splice(registered.routes.indexOf(route), 1);
			}
		}
	};
	const ctx = {
		...registered,
		get: (key) => routes[key],
		logger: {
			warn: (message) => registered.warnings.push(String(message))
		},
		effect: (body, label) => child({}).effect(body, label),
		inject(names, callback) {
			if (names.includes("connection") && !connection) return;
			callback(child({ connection: connection === "bare" ? {} : connection ? connectionService : void 0 }));
		}
	};
	return ctx;
}

/** A settings service double describing one OpenRouter route. */
function settings() {
	return {
		describe: () => [{
			ns: "llm-pi-ai",
			revision: 2,
			value: { providers: {
				"openrouter-live": {
					displayName: "OpenRouter",
					baseURL: "https://openrouter.ai/api/v1",
					apiKeyEnv: "OPENROUTER_API_KEY",
					models: []
				},
				zai: {
					displayName: "Z.AI",
					baseURL: "https://api.z.ai/api/paas/v4",
					models: []
				}
			} }
		}],
		mutate: async () => {}
	};
}

test("the plugin names itself for Loader diagnostics", () => {
	assert.equal(name, "reasoning-sync");
});

test("apply offers the Models page its two routes", () => {
	const ctx = context();
	apply(ctx);
	assert.deepEqual(ctx.routes.map((route) => route.path), [SYNC_ROUTE, ROUTES_ROUTE], "the card gets both routes");
	assert.deepEqual(ctx.routes.map((route) => route.methods), [["POST"], ["GET"]], "a sync is a write, so it is a POST");
	assert.deepEqual(ctx.routes.map((route) => route.requestBody), ["buffered", "buffered"], "both bodies are buffered before the handler runs");
	assert.deepEqual(ctx.warnings, [], "a profile with Connection warns about nothing");
});

test("the routes are the whole Host surface", () => {
	const ctx = context();
	apply(ctx);
	assert.deepEqual(ctx.disposed.map((entry) => entry.label), ["reasoning-sync: Models card routes"], "one effect owns everything the Host half registers — no tool, no service, no event listener");
});

test("a profile without Connection is a profile without a card, and nothing else", () => {
	const ctx = context({ connection: false });
	assert.doesNotThrow(() => apply(ctx));
	assert.deepEqual(ctx.routes, []);
	assert.deepEqual(ctx.warnings, [], "waiting for a service is not a failure to report");
});

test("a Connection without a Fetch registry says what it lost", () => {
	const ctx = context({ connection: "bare" });
	assert.doesNotThrow(() => apply(ctx));
	assert.deepEqual(ctx.routes, []);
	assert.equal(ctx.warnings.length, 1);
	assert.match(ctx.warnings[0], /Models card cannot reach this Host/u);
});

test("a route the registry refuses does not take the other one down", () => {
	const ctx = context({ failSecondRoute: true });
	assert.doesNotThrow(() => apply(ctx));
	assert.deepEqual(ctx.routes.map((route) => route.path), [SYNC_ROUTE], "the surviving route stays registered");
	assert.equal(ctx.warnings.length, 1);
	assert.match(ctx.warnings[0], /cannot register/u);
});

test("unloading the plugin unregisters everything it registered", () => {
	const ctx = context();
	apply(ctx);
	for (const { dispose } of ctx.disposed) dispose();
	assert.deepEqual(ctx.routes, []);
});

test("the route list answers with the routes the settings service actually holds", async () => {
	const ctx = context({ routes: { settings: settings() } });
	apply(ctx);
	const route = ctx.routes.find((candidate) => candidate.path === ROUTES_ROUTE);
	const answer = await (await route.fetch(new Request(`http://127.0.0.1:19387${ROUTES_ROUTE}`))).json();
	assert.deepEqual(answer, {
		namespaces: ["llm-pi-ai"],
		routes: [{
			provider: "openrouter-live",
			displayName: "OpenRouter",
			namespace: "llm-pi-ai"
		}]
	}, "the other provider in the same entry is not served");
});

test("the route list is empty, not broken, when there is no settings service", async () => {
	const ctx = context();
	apply(ctx);
	const route = ctx.routes.find((candidate) => candidate.path === ROUTES_ROUTE);
	const answer = await (await route.fetch(new Request(`http://127.0.0.1:19387${ROUTES_ROUTE}`))).json();
	assert.deepEqual(answer, {
		namespaces: [],
		routes: []
	});
});

test("the sync route runs the operation against the services the profile holds", async () => {
	const ctx = context({ routes: {
		settings: settings(),
		credentials: { resolve: async () => ({ value: "sk-test" }) }
	} });
	const previousFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({
			url,
			init
		});
		return {
			ok: true,
			status: 200,
			json: async () => ({ data: [] })
		};
	};
	try {
		apply(ctx);
		const route = ctx.routes.find((candidate) => candidate.path === SYNC_ROUTE);
		const answer = await (await route.fetch(new Request(`http://127.0.0.1:19387${SYNC_ROUTE}`, {
			method: "POST",
			body: JSON.stringify({ provider: "openrouter-live" })
		}))).json();
		assert.equal(answer.ok, true);
		assert.equal(answer.provider, "openrouter-live");
		assert.equal(answer.action, "preview", "a body with no action only reads");
		assert.equal(calls.length, 1, "the operation read the endpoint the route names");
		assert.equal(calls[0].url, "https://openrouter.ai/api/v1/models");
		assert.equal(calls[0].init.headers.authorization, "Bearer sk-test", "with the credential the route's own reference resolves to");
	} finally {
		globalThis.fetch = previousFetch;
	}
});

for (const { title, body } of cases) {
	try {
		await body();
		passed += 1;
	} catch (error) {
		failures.push(`${title}\n    ${String(error?.message ?? error).split("\n").join("\n    ")}`);
	}
}

if (failures.length > 0) {
	console.error(`\n${failures.length} failing, ${passed} passing\n`);
	for (const failure of failures) console.error(`  ✗ ${failure}\n`);
	process.exit(1);
}
console.log(`ok — ${passed} tests passing`);
