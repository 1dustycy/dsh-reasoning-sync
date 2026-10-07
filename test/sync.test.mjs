/**
 * S2 — the Host sync operation, against injected doubles.
 *
 * Nothing here touches the network, a real profile, or the running app: the
 * operation takes the settings service, the credentials service, the request
 * function, and the launch environment as inputs, so every failure class the
 * spec names is reachable in a plain Node process.
 *
 * The load-bearing assertions are the two the spec calls out: **the path ops
 * name `reasoningEfforts` and nothing else**, and **a failure writes not one
 * op**.
 *
 * Run with `node test/sync.test.mjs`.
 */

import assert from "node:assert/strict";
import { createReasoningSync } from "../lib/sync.js";

let passed = 0;
const failures = [];
const cases = [];

/** Register one named test; failures are collected instead of stopping the run. */
function test(title, body) {
	cases.push({ title, body });
}

/** The route the user actually has, trimmed to the fields this plugin reads. */
function providers(overrides = {}) {
	return {
		"openrouter-live": {
			displayName: "OpenRouter",
			api: "openai-completions",
			baseURL: "https://openrouter.ai/api/v1",
			apiKeyEnv: "OPENROUTER_API_KEY",
			models: [
				{ id: "stealth/space-bunny-alpha", name: "Space Bunny Alpha" },
				{
					id: "openai/gpt-6.1-sol",
					name: "GPT-6.1 Sol",
					reasoningEfforts: { high: "high" }
				}
			],
			...overrides
		}
	};
}

/** A settings service double recording every attempted mutation, and the ones that landed. */
function settingsDouble({ value = { providers: providers() }, ns = "llm-pi-ai", revision = 7, fail } = {}) {
	const calls = [];
	const written = [];
	return {
		calls,
		written,
		describe: () => [{ ns, revision, value }],
		mutate: async (calledNs, ops, expectedRevision) => {
			calls.push({ ns: calledNs, ops, expectedRevision });
			if (fail !== void 0) throw fail;
			written.push({ ns: calledNs, ops, expectedRevision });
		}
	};
}

/** A credentials service double. */
function credentialsDouble(entries = {}) {
	const asked = [];
	return {
		asked,
		resolve: async (ref) => {
			asked.push(ref);
			return entries[ref] === void 0 ? void 0 : { value: entries[ref] };
		}
	};
}

/** The revision-conflict error the shipped settings service throws. */
function conflictError() {
	const error = new Error("settings namespace \"llm-pi-ai\" changed since it was read (expected revision 7, now 9)");
	error.name = "SettingsConflictError";
	error.code = "SETTINGS_CONFLICT";
	error.expected = 7;
	error.actual = 9;
	return error;
}

/** A catalog body as the endpoint publishes it. */
function catalogBody(models) {
	return {
		data: models.map(([id, efforts, extra = {}]) => ({
			id,
			name: id,
			reasoning: {
				mandatory: false,
				supported_efforts: efforts,
				default_effort: efforts[0],
				...extra
			}
		}))
	};
}

/** A request double answering one canned response and recording the call. */
function requestDouble(response) {
	const calls = [];
	const request = async (url, init) => {
		calls.push({ url, init });
		if (response instanceof Error) throw response;
		return {
			ok: response.status >= 200 && response.status < 300,
			status: response.status,
			json: async () => {
				if (response.body instanceof Error) throw response.body;
				return response.body;
			}
		};
	};
	return { calls, request };
}

/** The operation under test, wired to doubles. */
function harness({ response = { status: 200, body: catalogBody([["openai/gpt-6.1-sol", ["high", "low"]]]) }, settings = settingsDouble(), credentials = credentialsDouble({ OPENROUTER_API_KEY: "sk-test" }), environment = { OPENROUTER_API_KEY: void 0 } } = {}) {
	const { calls, request } = requestDouble(response);
	return {
		settings,
		credentials,
		requests: calls,
		sync: createReasoningSync({
			settings,
			credentials,
			request,
			environment: { get: (ref) => environment[ref] }
		})
	};
}

const ROUTE = "openrouter-live";

// --- the happy path ----------------------------------------------------------

test("preview reports the difference and writes nothing", async () => {
	const { sync, settings, requests } = harness();
	const result = await sync.run({ provider: ROUTE, action: "preview" });
	assert.equal(result.ok, true);
	assert.deepEqual(result.changes, ["openai/gpt-6.1-sol"], "only the model whose declaration drifts is a change");
	assert.deepEqual(result.verdicts.map((verdict) => verdict.kind), ["keep", "update"], "the cloaked model is kept, the drifting one updated");
	assert.equal(settings.calls.length, 0, "a preview never writes");
	assert.equal(requests.length, 1, "a preview still reads the endpoint");
});

test("apply writes one set op per changed model, naming only reasoningEfforts", async () => {
	const { sync, settings } = harness();
	const result = await sync.run({ provider: ROUTE, action: "apply" });
	assert.equal(result.ok, true);
	assert.equal(settings.calls.length, 1, "one mutation for the whole route");
	const [call] = settings.calls;
	assert.equal(call.ns, "llm-pi-ai", "the write addresses the entry that holds the route");
	assert.equal(call.expectedRevision, 7, "the revision comes from the read that produced the plan");
	assert.deepEqual(call.ops, [{
		op: "set",
		path: [
			"providers",
			ROUTE,
			"models",
			1,
			"reasoningEfforts"
		],
		value: {
			low: "low",
			high: "high"
		}
	}], "the op addresses the second model's declaration by index and carries the mapped levels");
});

test("the request carries the resolved credential and reads the route's own catalog", async () => {
	const { sync, requests, credentials } = harness();
	await sync.run({ provider: ROUTE, action: "preview" });
	assert.deepEqual(credentials.asked, ["OPENROUTER_API_KEY"], "the reference comes from the route's own apiKeyEnv");
	assert.equal(requests[0].url, "https://openrouter.ai/api/v1/models", "the catalog hangs off the route's baseURL");
	assert.equal(requests[0].init.headers.authorization, "Bearer sk-test");
	assert.ok(requests[0].init.signal instanceof AbortSignal, "and the read is bounded");
});

test("the catalog read is bounded, so an endpoint that never answers is still an answer", async () => {
	const sync = createReasoningSync({
		settings: settingsDouble(),
		credentials: credentialsDouble({ OPENROUTER_API_KEY: "sk-test" }),
		environment: { get: () => void 0 },
		timeoutMs: 10,
		request: (url, init) => new Promise((_resolve, reject) => {
			assert.ok(init.signal instanceof AbortSignal, "the request carries an abort signal");
			// An endpoint that accepts the connection and then says nothing: only the
			// signal ends this request. The ref'd timer is what keeps the process
			// alive while it waits — `AbortSignal.timeout` alone does not.
			const held = setTimeout(() => reject(new Error("the request outlived its timeout")), 1_000);
			init.signal.addEventListener("abort", () => {
				clearTimeout(held);
				reject(init.signal.reason);
			}, { once: true });
		})
	});
	const result = await sync.run({ provider: ROUTE, action: "apply" });
	assert.equal(result.ok, false);
	assert.equal(result.kind, "transport");
	assert.match(result.message, /abort/iu, "the reason says the request was cut short");
});

test("a route with nothing to change is written nowhere", async () => {
	const settings = settingsDouble({
		value: { providers: providers({ models: [{ id: "openai/gpt-6.1-sol", reasoningEfforts: { low: "low", high: "high" } }] }) }
	});
	const { sync } = harness({ settings });
	const result = await sync.run({ provider: ROUTE, action: "apply" });
	assert.equal(result.ok, true);
	assert.deepEqual(result.changes, [], "nothing drifts");
	assert.equal(settings.calls.length, 0, "an in-sync route is not mutated");
});

test("a non-reasoning model is cleared to false", async () => {
	const settings = settingsDouble({
		value: { providers: providers({ models: [{ id: "openai/gpt-6.1-sol", reasoningEfforts: { high: "high" } }] }) }
	});
	const { sync } = harness({ settings, response: { status: 200, body: catalogBody([["openai/gpt-6.1-sol", []]]) } });
	const result = await sync.run({ provider: ROUTE, action: "apply" });
	assert.equal(result.ok, true);
	assert.deepEqual(settings.calls[0].ops, [{
		op: "set",
		path: [
			"providers",
			ROUTE,
			"models",
			0,
			"reasoningEfforts"
		],
		value: false
	}]);
});

test("a level the adapter does not know is reported, and the route is left alone", async () => {
	const settings = settingsDouble({
		value: { providers: providers({ models: [{ id: "openai/gpt-6.1-sol", reasoningEfforts: { high: "high" } }] }) }
	});
	const { sync } = harness({ settings, response: { status: 200, body: catalogBody([["openai/gpt-6.1-sol", ["ultra"]]]) } });
	const result = await sync.run({ provider: ROUTE, action: "apply" });
	assert.equal(result.ok, true);
	assert.deepEqual(result.changes, []);
	assert.deepEqual(result.verdicts[0].capability.unknown, ["ultra"]);
	assert.equal(settings.calls.length, 0, "an unmappable capability writes nothing at all");
});

test("the launch environment backs a credential the store has not got", async () => {
	const credentials = credentialsDouble({});
	const { sync, requests } = harness({
		credentials,
		environment: { OPENROUTER_API_KEY: "sk-launch" }
	});
	const result = await sync.run({ provider: ROUTE, action: "preview" });
	assert.equal(result.ok, true);
	assert.deepEqual(credentials.asked, ["OPENROUTER_API_KEY"], "the store is asked first");
	assert.equal(requests[0].init.headers.authorization, "Bearer sk-launch");
});

// --- failures write nothing --------------------------------------------------

/**
 * Every failure the spec names, each asserting the same invariant: not one op
 * lands. `attempted` marks the failures that can only be discovered by offering
 * the write — a refusal is still not a write.
 * @param title - the case name.
 * @param options - harness overrides plus the expected failure kind.
 */
function failing(title, { kind, message, attempted = false, ...options }) {
	test(title, async () => {
		const { sync, settings } = harness(options);
		const result = await sync.run({ provider: ROUTE, action: "apply" });
		assert.equal(result.ok, false, "the operation reports failure");
		assert.equal(result.kind, kind);
		assert.match(result.message, message, "the failure names its reason");
		assert.deepEqual(settings.written, [], "a failed sync writes no ops");
		if (!attempted) assert.equal(settings.calls.length, 0, "the write was never even offered");
	});
}

failing("no credential is a named failure", {
	kind: "no-credential",
	message: /OPENROUTER_API_KEY/u,
	credentials: credentialsDouble({}),
	environment: {}
});

failing("a route that names no credential reference fails the same way", {
	kind: "no-credential",
	message: /apiKeyEnv/u,
	settings: settingsDouble({ value: { providers: providers({ apiKeyEnv: void 0 }) } })
});

failing("an endpoint that answers 401 is a named failure", {
	kind: "endpoint",
	message: /401/u,
	response: { status: 401, body: { error: "no" } }
});

failing("an endpoint that answers 500 is a named failure", {
	kind: "endpoint",
	message: /500/u,
	response: { status: 500, body: {} }
});

failing("a body that is not JSON is a named failure", {
	kind: "catalog",
	message: /JSON/u,
	response: { status: 200, body: new SyntaxError("Unexpected token < in JSON at position 0") }
});

failing("a JSON body that carries no catalog is a named failure", {
	kind: "catalog",
	message: /catalog/u,
	response: { status: 200, body: { ok: true } }
});

failing("a request that throws is a named failure", {
	kind: "transport",
	message: /timed out/u,
	response: new Error("The operation timed out")
});

failing("a route that is not configured is a named failure", {
	kind: "no-route",
	message: new RegExp(ROUTE, "u"),
	settings: settingsDouble({ value: { providers: {} } })
});

failing("a revision conflict is reported, not retried", {
	kind: "conflict",
	message: /changed since it was read/u,
	attempted: true,
	settings: settingsDouble({ fail: conflictError() })
});

failing("a namespace that will not take the field is reported", {
	kind: "unwritable",
	message: /not volatile/u,
	attempted: true,
	settings: settingsDouble({ fail: new Error("Config field \"providers.openrouter-live\" is not volatile") })
});

failing("a route that declares no endpoint to read is a named failure", {
	kind: "no-route",
	message: /baseURL/u,
	settings: settingsDouble({ value: { providers: providers({ baseURL: void 0 }) } })
});

test("a conflicting run leaves the declaration for the retry that re-reads it", async () => {
	let attempt = 0;
	const settings = settingsDouble();
	settings.mutate = async (ns, ops, expectedRevision) => {
		settings.calls.push({ ns, ops, expectedRevision });
		attempt += 1;
		if (attempt === 1) throw conflictError();
	};
	const { sync } = harness({ settings });
	assert.equal((await sync.run({ provider: ROUTE, action: "apply" })).kind, "conflict");
	const retry = await sync.run({ provider: ROUTE, action: "apply" });
	assert.equal(retry.ok, true, "a re-run reads the current revision and succeeds");
	assert.equal(settings.calls.length, 2);
});

test("a missing settings service is a named failure, not a crash", async () => {
	const sync = createReasoningSync({
		settings: void 0,
		credentials: credentialsDouble({}),
		request: async () => ({ ok: true, status: 200, json: async () => catalogBody([]) }),
		environment: { get: () => void 0 }
	});
	const result = await sync.run({ provider: ROUTE, action: "apply" });
	assert.equal(result.ok, false);
	assert.equal(result.kind, "unavailable");
});

test("a run with no action reads and does not write", async () => {
	const { sync, settings } = harness();
	const result = await sync.run({ provider: ROUTE });
	assert.equal(result.ok, true);
	assert.equal(result.action, "preview");
	assert.equal(result.written, false);
	assert.equal(settings.calls.length, 0, "an unstated action must never write");
});

test("an action that is neither preview nor apply is refused", async () => {
	const { sync, settings } = harness();
	const result = await sync.run({ provider: ROUTE, action: "sideways" });
	assert.equal(result.ok, false);
	assert.equal(result.kind, "action");
	assert.equal(settings.calls.length, 0);
});

// --- what the caller sees ----------------------------------------------------

test("the result names the provider and the action it took", async () => {
	const { sync } = harness();
	const preview = await sync.run({ provider: ROUTE, action: "preview" });
	assert.equal(preview.provider, ROUTE);
	assert.equal(preview.action, "preview");
	assert.equal(preview.written, false);
	const applied = await sync.run({ provider: ROUTE, action: "apply" });
	assert.equal(applied.action, "apply");
	assert.equal(applied.written, true);
});

test("a model whose declaration already matches is not part of the change list", async () => {
	const settings = settingsDouble({
		value: {
			providers: providers({
				models: [
					{ id: "openai/gpt-6.1-sol", reasoningEfforts: { low: "low", high: "high" } },
					{ id: "anthropic/claude-sonnet-5.5", reasoningEfforts: { high: "high" } }
				]
			})
		}
	});
	const { sync } = harness({
		settings,
		response: {
			status: 200,
			body: catalogBody([
				["openai/gpt-6.1-sol", ["high", "low"]],
				["anthropic/claude-sonnet-5.5", ["high", "low"]]
			])
		}
	});
	const result = await sync.run({ provider: ROUTE, action: "apply" });
	assert.deepEqual(result.changes, ["anthropic/claude-sonnet-5.5"]);
	assert.deepEqual(settings.calls[0].ops.map((op) => op.path[3]), [1], "the drifting model is addressed by its own index");
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
