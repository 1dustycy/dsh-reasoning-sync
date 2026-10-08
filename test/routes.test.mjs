/**
 * The Host's HTTP surface: which routes it serves, and what one sync request
 * answers.
 *
 * Both handlers are plain request/response functions, so the whole surface runs
 * in a Node process against doubles — no server, no browser, no profile.
 *
 * Run with `node test/routes.test.mjs`.
 */

import assert from "node:assert/strict";
import {
	CATALOG_HOSTS,
	ROUTES_ROUTE,
	SYNC_ROUTE,
	routesResponse,
	syncResponse,
	syncableRoutes
} from "../lib/routes.js";

let passed = 0;
const failures = [];
const cases = [];

/** Register one named test; failures are collected instead of stopping the run. */
function test(title, body) {
	cases.push({ title, body });
}

/** One settings descriptor around a `providers` dict. */
function descriptor(ns, providers) {
	return {
		ns,
		revision: 3,
		value: { providers }
	};
}

/** A route profile carrying only what the filter reads. */
function profile(baseURL, displayName = "OpenRouter") {
	return {
		displayName,
		baseURL,
		api: "openai-completions",
		apiKeyEnv: "OPENROUTER_API_KEY",
		models: []
	};
}

// --- which routes are served -------------------------------------------------

test("a route aimed at the catalog host is served, with the namespace that holds it", () => {
	const found = syncableRoutes([descriptor("llm-pi-ai", { "openrouter-live": profile("https://openrouter.ai/api/v1") })]);
	assert.deepEqual(found.namespaces, ["llm-pi-ai"], "the seat key travels with the route — the adapter entry id is read, not assumed");
	assert.deepEqual(found.routes, [{
		provider: "openrouter-live",
		displayName: "OpenRouter",
		namespace: "llm-pi-ai"
	}]);
});

test("every other provider in the same page is left alone", () => {
	const found = syncableRoutes([descriptor("llm-pi-ai", {
		"openrouter-live": profile("https://openrouter.ai/api/v1"),
		xiaomi: profile("https://api.xiaomimimo.com/v1", "Xiaomi"),
		zai: profile("https://api.z.ai/api/paas/v4", "Z.ai"),
		"deepseek-account": profile("https://api.deepseek.com", "DeepSeek")
	})]);
	assert.deepEqual(found.routes.map((route) => route.provider), ["openrouter-live"]);
});

test("a catalog host is matched on the host, not on a substring of the url", () => {
	assert.deepEqual(syncableRoutes([descriptor("ns", {
		"real-subdomain": profile("https://edge.openrouter.ai/api/v1"),
		"look-alike": profile("https://openrouter.ai.example.com/api/v1"),
		"in-a-query": profile("https://evil.example.com/?next=openrouter.ai"),
		"not-a-url": profile("openrouter.ai/api/v1"),
		"not-a-string": profile()
	})]).routes.map((route) => route.provider), ["real-subdomain"]);
});

test("the served list is ordered by route, so two pages read the same", () => {
	const found = syncableRoutes([
		descriptor("b-ns", { zulu: profile("https://openrouter.ai/api/v1", "Z") }),
		descriptor("a-ns", { alpha: profile("https://openrouter.ai/api/v1", "A") })
	]);
	assert.deepEqual(found.routes.map((route) => route.provider), ["alpha", "zulu"]);
	assert.deepEqual(found.namespaces, ["b-ns", "a-ns"], "namespaces stay in descriptor order");
});

test("a profile with no display name falls back to the route key", () => {
	const [route] = syncableRoutes([descriptor("llm-pi-ai", { "openrouter-live": profile("https://openrouter.ai/api/v1", "") })]).routes;
	assert.equal(route.displayName, "openrouter-live");
});

test("a profile with no settings entry at all serves nothing", () => {
	for (const input of [void 0, null, [], [{}], [descriptor("ns", void 0)], [descriptor("ns", [])]]) {
		assert.deepEqual(syncableRoutes(input), {
			namespaces: [],
			routes: []
		}, `${JSON.stringify(input)} serves nothing`);
	}
});

test("the catalog host list is the one the mapping is defined against", () => {
	assert.deepEqual(CATALOG_HOSTS, ["openrouter.ai"]);
});

// --- the two responses -------------------------------------------------------

test("the route list is served as JSON", async () => {
	const response = routesResponse({
		namespaces: ["llm-pi-ai"],
		routes: []
	});
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		namespaces: ["llm-pi-ai"],
		routes: []
	});
});

test("a sync request runs the operation, with the action it asked for", async () => {
	const asked = [];
	const response = await syncResponse(new Request(`http://127.0.0.1:19387${SYNC_ROUTE}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			provider: "openrouter-live",
			action: "preview"
		})
	}), async (input) => {
		asked.push(input);
		return {
			ok: true,
			provider: input.provider,
			action: input.action,
			changes: [],
			written: false
		};
	});
	assert.deepEqual(asked, [{
		provider: "openrouter-live",
		action: "preview"
	}]);
	assert.equal(response.status, 200);
	assert.equal((await response.json()).action, "preview");
});

test("a sync request with no action leaves the choice to the operation", async () => {
	let seen;
	await syncResponse(new Request(`http://127.0.0.1:19387${SYNC_ROUTE}`, {
		method: "POST",
		body: JSON.stringify({ provider: "openrouter-live" })
	}), async (input) => {
		seen = input;
		return { ok: true };
	});
	assert.deepEqual(seen, { provider: "openrouter-live" }, "the route does not decide what an unstated action means; the operation's own default does, and that default reads rather than writes");
});

test("an operation failure is still a 200, because it is an answer", async () => {
	const response = await syncResponse(new Request(`http://127.0.0.1:19387${SYNC_ROUTE}`, {
		method: "POST",
		body: JSON.stringify({ provider: "openrouter-live" })
	}), async () => ({
		ok: false,
		kind: "no-credential",
		message: "OPENROUTER_API_KEY is not set"
	}));
	assert.equal(response.status, 200, "the caller reads the reason from the body, not from a status code");
	assert.deepEqual(await response.json(), {
		ok: false,
		kind: "no-credential",
		message: "OPENROUTER_API_KEY is not set"
	});
});

test("a body that is not JSON is refused without running anything", async () => {
	let ran = false;
	const response = await syncResponse(new Request(`http://127.0.0.1:19387${SYNC_ROUTE}`, {
		method: "POST",
		body: "not json"
	}), async () => {
		ran = true;
		return { ok: true };
	});
	assert.equal(response.status, 400);
	assert.equal(ran, false, "an unreadable request must not reach the operation");
	assert.equal((await response.json()).kind, "request");
});

test("both routes live under the /api fence, and are two distinct paths", () => {
	for (const route of [SYNC_ROUTE, ROUTES_ROUTE]) assert.match(route, /^\/api\/\S+$/u, `${route} lives under the fence Connection serves`);
	assert.notEqual(SYNC_ROUTE, ROUTES_ROUTE, "one path cannot answer both questions");
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
