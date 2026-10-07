/**
 * The Client half: the card, and the seat it claims.
 *
 * The bundle is the built artifact, so the suite loads it the way the browser
 * module loader does — a stub `window.__ModuleLoader__` captures the factory and
 * materializing it yields the plugin's exports. Rendering then runs against a
 * minimal hook runtime, which is enough for a card whose whole behaviour is one
 * state value, one effect, and one button: no DOM, no browser harness.
 *
 * The Host is a fetch double, so every answer the card can meet — a drifting
 * route, an up-to-date one, a failure with a reason, an endpoint that publishes
 * a level the adapter does not know — is reachable here.
 *
 * Run with `node test/client.test.mjs`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ROUTES_ROUTE, SYNC_ROUTE } from "../lib/routes.js";

let passed = 0;
const failures = [];
const cases = [];

/** Register one named test; failures are collected instead of stopping the run. */
function test(title, body) {
	cases.push({ title, body });
}

// --- the hook runtime the component renders against --------------------------

/**
 * Build a minimal React: elements are plain objects, and `useState` /
 * `useEffect` work over one mounted instance's hook slots.
 * @returns the element factory plus its `mount` driver.
 */
function createReact() {
	let current;
	const React = {
		createElement(type, props, ...children) {
			return {
				type,
				props: {
					...(props ?? {}),
					children: children.length === 0 ? void 0 : children.length === 1 ? children[0] : children
				}
			};
		},
		useState(initial) {
			const hook = current.hooks[current.index] ??= { value: typeof initial === "function" ? initial() : initial };
			current.index += 1;
			return [hook.value, (next) => {
				hook.value = typeof next === "function" ? next(hook.value) : next;
				current.rerender();
			}];
		},
		useEffect(body, deps) {
			const hook = current.hooks[current.index] ??= {};
			current.index += 1;
			if (hook.deps !== void 0 && deps !== void 0 && deps.length === hook.deps.length && deps.every((dep, index) => Object.is(dep, hook.deps[index]))) return;
			hook.deps = deps;
			current.pending.push(() => {
				if (typeof hook.cleanup === "function") hook.cleanup();
				hook.cleanup = body();
			});
		}
	};
	/**
	 * Render one component and run the effects the render asked for.
	 * @param Component - the component.
	 * @param props - its props.
	 * @returns the mounted instance, with `tree` and a `rerender` entry point.
	 */
	function mount(Component, props) {
		const instance = {
			hooks: [],
			index: 0,
			pending: [],
			tree: null
		};
		instance.rerender = () => {
			current = instance;
			instance.index = 0;
			instance.tree = Component(props);
			// The seat renders a wrapper around the card, so resolve function
			// components down to the host element the card actually returns.
			while (typeof instance.tree?.type === "function") instance.tree = instance.tree.type(instance.tree.props);
			// Effects register while rendering, so they are drained after it.
			const pending = instance.pending;
			instance.pending = [];
			for (const run of pending) run();
		};
		instance.rerender();
		return instance;
	}
	return {
		React,
		mount
	};
}

/** Every string in one element tree, in render order. */
function texts(node, out = []) {
	if (typeof node === "string") out.push(node);
	else if (Array.isArray(node)) for (const child of node) texts(child, out);
	else if (node !== null && node !== void 0 && typeof node === "object") texts(node.props?.children, out);
	return out;
}

/** Every element of one type in a tree. */
function elements(node, type, out = []) {
	if (Array.isArray(node)) for (const child of node) elements(child, type, out);
	else if (node !== null && node !== void 0 && typeof node === "object") {
		if (node.type === type) out.push(node);
		elements(node.props?.children, type, out);
	}
	return out;
}

/** Every style object in a tree. */
function styles(node, out = []) {
	if (Array.isArray(node)) for (const child of node) styles(child, out);
	else if (node !== null && node !== void 0 && typeof node === "object") {
		if (node.props?.style !== void 0) out.push(node.props.style);
		styles(node.props?.children, out);
	}
	return out;
}

/** Let the card's promise chains settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// --- the bundle, loaded the way the browser loads it -------------------------

const bundle = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

/**
 * Materialize the client bundle.
 * @returns the plugin's exports.
 */
function loadPlugin() {
	const registrations = [];
	const sandbox = {
		window: {
			__ModuleLoader__: {
				load(record) {
					registrations.push(record);
				}
			}
		},
		console,
		AbortSignal,
		fetch: (...args) => globalThis.fetch(...args)
	};
	vm.createContext(sandbox);
	vm.runInContext(bundle, sandbox, { filename: "client.js" });
	assert.equal(registrations.length, 1, "the bundle registers exactly one module");
	assert.equal(registrations[0].id, "dsh-reasoning-sync", "under the package's own name");
	return registrations[0].factory((specifier) => {
		if (specifier === "react") return runtime.React;
		throw new Error(`this bundle must not require ${JSON.stringify(specifier)}`);
	});
}

/** One hook runtime serves the bundle and every mount, the way the page shares one React. */
const runtime = createReact();

const plugin = loadPlugin();

/**
 * A client context double: the two services the half injects, and the seat it
 * claims.
 * @returns the context plus what was registered through it.
 */
function clientContext() {
	const cells = [];
	const injected = [];
	const locales = [];
	const effects = [];
	const ctx = {
		cells,
		injected,
		locales,
		effects,
		slots: {
			inject(key, callback) {
				injected.push(key);
				callback();
			},
			register(options, Component) {
				cells.push({
					options,
					Component
				});
				return () => {};
			}
		},
		locale: {
			register(ns, dictionary) {
				locales.push({
					ns,
					dictionary
				});
				return () => {};
			},
			bind: (ns) => (key, params) => {
				const template = locales.at(-1)?.dictionary.zh?.[key] ?? key;
				return params === void 0 ? template : template.replace(/\{(\w+)\}/gu, (match, name) => (name in params ? String(params[name]) : match));
			}
		},
		effect(body, label) {
			effects.push(label);
			return body();
		}
	};
	return ctx;
}

/**
 * Answer the two Host routes.
 * @param answers - `(body, path) => result`, or a fixed result for every sync call.
 * @returns the recorded calls.
 */
function hostDouble(answers) {
	const calls = [];
	globalThis.fetch = async (path, init) => {
		const body = init?.body === void 0 ? void 0 : JSON.parse(init.body);
		calls.push({
			path,
			method: init?.method,
			body,
			bounded: init?.signal instanceof AbortSignal
		});
		const answer = typeof answers === "function" ? answers(body, path) : answers;
		if (answer === void 0) return {
			ok: false,
			status: 404,
			json: async () => ({})
		};
		return {
			ok: true,
			status: 200,
			json: async () => answer
		};
	};
	return calls;
}

/** The route list one OpenRouter route produces. */
const LISTED = {
	namespaces: ["llm-pi-ai"],
	routes: [{
		provider: "openrouter-live",
		displayName: "OpenRouter",
		namespace: "llm-pi-ai"
	}]
};

/** A result with one model drifting, one already in step, and one cloaked. */
function drifting() {
	return {
		ok: true,
		provider: "openrouter-live",
		action: "preview",
		written: false,
		changes: ["openai/gpt-6.1-sol"],
		verdicts: [
			{
				id: "stealth/space-bunny-alpha",
				kind: "keep",
				reason: "cloaked",
				capability: null
			},
			{
				id: "openai/gpt-6.1-sol",
				kind: "update",
				declared: { high: "high" },
				efforts: {
					low: "low",
					high: "high",
					max: "max"
				},
				capability: {
					levels: ["low", "high", "max"],
					unknown: [],
					mandatory: true,
					defaultEffort: "medium"
				}
			},
			{
				id: "anthropic/claude-opus-5.5",
				kind: "keep",
				reason: "in-sync",
				declared: {
					low: "low",
					medium: "medium"
				},
				capability: {
					levels: ["low", "medium"],
					unknown: [],
					mandatory: false
				}
			}
		]
	};
}

/** A result with nothing left to write. */
function current() {
	return {
		ok: true,
		provider: "openrouter-live",
		action: "preview",
		written: false,
		changes: [],
		verdicts: [{
			id: "openai/gpt-6.1-sol",
			kind: "keep",
			reason: "in-sync",
			declared: { high: "high" },
			capability: {
				levels: ["high"],
				unknown: [],
				mandatory: false
			}
		}]
	};
}

/** The provider share the seat hands the card. */
const PROVIDER = {
	provider: "openrouter-live",
	displayName: "OpenRouter",
	settingsNs: "llm-pi-ai",
	settingsPath: ["providers", "openrouter-live"],
	active: true
};

/**
 * The props the seat composes: the provider share plus the bound `t` the
 * registration's `locale` option earns.
 * @param ctx - the context whose locale service the card reads.
 * @param provider - the provider share, defaulting to the served route.
 * @returns the seat's props.
 */
function seatProps(ctx, provider = PROVIDER) {
	return {
		provider,
		configured: true,
		keyConfigured: true,
		t: ctx.locale.bind(plugin.LOCALE_NAMESPACE)
	};
}

// --- claiming the seat -------------------------------------------------------

test("the client half claims the reserved seat, keyed by the namespace the Host named", async () => {
	const calls = hostDouble((body, path) => (path === plugin.ROUTES_ROUTE ? LISTED : current()));
	const ctx = clientContext();
	await plugin.apply(ctx);
	assert.deepEqual(ctx.injected, [plugin.SLOT], "it waits for the seat the Models page declares");
	assert.equal(ctx.cells.length, 1, "one cell, for the one namespace that holds a served route");
	const [seat] = ctx.cells;
	assert.deepEqual({ ...seat.options }, {
		name: plugin.SLOT,
		key: "llm-pi-ai",
		id: "reasoning-sync",
		order: plugin.ORDER,
		locale: plugin.LOCALE_NAMESPACE
	});
	assert.deepEqual(ctx.locales.map((entry) => entry.ns), [plugin.LOCALE_NAMESPACE], "its copy is registered before anything renders");
	assert.deepEqual(Object.keys(ctx.locales[0].dictionary).sort(), ["en", "zh"], "both languages ship, or the key would render as the text");
	assert.equal(calls[0].bounded, true, "the seat discovery is bounded, so a Host that never answers cannot hold activation open");
	assert.deepEqual(ctx.effects, ["reasoning-sync: card copy"], "everything the half owns hangs on an effect, so unloading leaves no dictionary behind");
});

test("a namespace appears once, however many served routes it holds", async () => {
	hostDouble((body, path) => (path === plugin.ROUTES_ROUTE ? {
		namespaces: ["llm-pi-ai"],
		routes: [
			{
				provider: "openrouter-live",
				displayName: "OpenRouter",
				namespace: "llm-pi-ai"
			},
			{
				provider: "openrouter-work",
				displayName: "OpenRouter (work)",
				namespace: "llm-pi-ai"
			}
		]
	} : current()));
	const ctx = clientContext();
	await plugin.apply(ctx);
	assert.equal(ctx.cells.length, 1, "the seat is keyed per namespace, so two routes share one cell");
});

test("a Host that serves nothing gets no cell", async () => {
	hostDouble((body, path) => (path === plugin.ROUTES_ROUTE ? {
		namespaces: [],
		routes: []
	} : current()));
	const ctx = clientContext();
	await plugin.apply(ctx);
	assert.deepEqual(ctx.cells, [], "no served route means nothing to render anywhere");
});

test("a Host that cannot answer leaves the page untouched instead of guessing", async () => {
	hostDouble(() => void 0);
	const ctx = clientContext();
	const warnings = [];
	const original = console.warn;
	console.warn = (message) => warnings.push(String(message));
	try {
		await plugin.apply(ctx);
	} finally {
		console.warn = original;
	}
	assert.deepEqual(ctx.cells, []);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /which routes it serves/u);
});

test("the bundle's route paths are the Host's own, not a second guess", () => {
	assert.equal(plugin.SYNC_ROUTE, SYNC_ROUTE, "the two halves are separate artifacts, so only a test can keep their paths equal");
	assert.equal(plugin.ROUTES_ROUTE, ROUTES_ROUTE);
});

test("the bundle requires nothing but react from the platform seed table", () => {
	const specifiers = [...bundle.matchAll(/require\("([^"]+)"\)/gu)].map((match) => match[1]);
	assert.deepEqual(specifiers, ["react"], "no application package may be loaded as a module");
});

// --- what the card shows -----------------------------------------------------

test("a served route renders the difference between endpoint and declaration", async () => {
	hostDouble((body, path) => (path === plugin.ROUTES_ROUTE ? LISTED : drifting()));
	const ctx = clientContext();
	await plugin.apply(ctx);
	const instance = runtime.mount(ctx.cells[0].Component, seatProps(ctx));
	await settle();
	const shown = texts(instance.tree);
	assert.ok(shown.some((text) => text.includes("1 个模型")), "the headline counts what drifts");
	const comparison = shown.find((text) => text.includes("openai/gpt-6.1-sol"));
	assert.ok(comparison !== void 0, "the drifting model is named");
	assert.match(comparison, /当前 high → 端点 low · high · max/u, "both sides of the difference are shown, in declaration order");
	assert.match(comparison, /默认 medium/u, "and the level the endpoint falls back to");
	assert.ok(shown.some((text) => text.includes("stealth/space-bunny-alpha") && text.includes("保持原样")), "a cloaked model is named, and said to be left alone");
	assert.ok(shown.some((text) => text.includes("anthropic/claude-opus-5.5") && text.includes("已是最新")), "a model already in step is listed too, so the reader can tell it was checked");
	assert.ok(shown.some((text) => text.includes("不新增、不删除模型")), "and the card says what a sync will not touch");
	assert.equal(shown.filter((text) => text.includes("openai/gpt-6.1-sol") || text.includes("claude-opus-5.5") || text.includes("space-bunny")).length, 3, "every declared model earns exactly one row");
});

test("a route this plugin does not serve renders nothing at all", async () => {
	hostDouble((body, path) => (path === plugin.ROUTES_ROUTE ? LISTED : current()));
	const ctx = clientContext();
	await plugin.apply(ctx);
	const instance = runtime.mount(ctx.cells[0].Component, seatProps(ctx, {
		...PROVIDER,
		provider: "xiaomi",
		displayName: "Xiaomi"
	}));
	await settle();
	assert.equal(instance.tree, null, "another provider's card keeps its row to itself");
});

test("an up-to-date route says so, and offers only a re-check", async () => {
	hostDouble((body, path) => (path === plugin.ROUTES_ROUTE ? LISTED : current()));
	const ctx = clientContext();
	await plugin.apply(ctx);
	const instance = runtime.mount(ctx.cells[0].Component, seatProps(ctx));
	await settle();
	const shown = texts(instance.tree);
	assert.ok(shown.some((text) => text.includes("已是最新：与端点公布的等级一致")), "the user is told there is nothing to do");
	assert.ok(shown.some((text) => text.includes("openai/gpt-6.1-sol") && text.includes("已是最新 · high")), "and the declared model says so by name, with the levels it already has");
	const [button] = elements(instance.tree, "button");
	assert.equal(texts(button)[0], "重新检查", "the action re-reads instead of writing");
});

test("a failure is shown with its reason", async () => {
	hostDouble((body, path) => (path === plugin.ROUTES_ROUTE ? LISTED : {
		ok: false,
		kind: "no-credential",
		message: "provider route \"openrouter-live\" resolves OPENROUTER_API_KEY, which is not set"
	}));
	const ctx = clientContext();
	await plugin.apply(ctx);
	const instance = runtime.mount(ctx.cells[0].Component, seatProps(ctx));
	await settle();
	const shown = texts(instance.tree);
	assert.ok(shown.some((text) => text.includes("同步失败") && text.includes("OPENROUTER_API_KEY")), "the reason reaches the reader");
});

test("levels the adapter does not know are reported as left alone", async () => {
	hostDouble((body, path) => (path === plugin.ROUTES_ROUTE ? LISTED : {
		...current(),
		verdicts: [{
			id: "openai/gpt-6.1-sol",
			kind: "keep",
			reason: "unmappable",
			capability: {
				levels: [],
				unknown: ["ultra"],
				mandatory: false
			}
		}]
	}));
	const ctx = clientContext();
	await plugin.apply(ctx);
	const instance = runtime.mount(ctx.cells[0].Component, seatProps(ctx));
	await settle();
	const shown = texts(instance.tree);
	assert.ok(shown.some((text) => text.includes("不认识") && text.includes("保持原样")), "the verdict itself says the level set is unrecognized");
	assert.ok(shown.some((text) => text.includes("ultra")), "and the levels the adapter does not know are named rather than guessed at");
});

test("a cleared model shows what it declared, and a dropped off key is reported", async () => {
	hostDouble((body, path) => (path === plugin.ROUTES_ROUTE ? LISTED : {
		...drifting(),
		verdicts: [
			{
				id: "openai/gpt-6.1-sol",
				kind: "clear",
				reason: "non-reasoning",
				declared: { high: "high" },
				capability: {
					levels: [],
					unknown: [],
					mandatory: false
				}
			},
			{
				id: "anthropic/claude-sonnet-5.5",
				kind: "update",
				declared: {
					off: null,
					high: "high"
				},
				efforts: { high: "high" },
				removed: ["off"],
				capability: {
					levels: ["high"],
					unknown: [],
					mandatory: true
				}
			}
		]
	}));
	const ctx = clientContext();
	await plugin.apply(ctx);
	const instance = runtime.mount(ctx.cells[0].Component, seatProps(ctx));
	await settle();
	const shown = texts(instance.tree);
	assert.ok(shown.some((text) => text.includes("当前 high") && text.includes("reasoningEfforts: false")), "a clear names what was declared");
	assert.ok(shown.some((text) => text.includes("off 声明被移除")), "a dropped off key is stated, not done silently");
});

test("the card's colours are theme tokens, never literals", async () => {
	hostDouble((body, path) => (path === plugin.ROUTES_ROUTE ? LISTED : drifting()));
	const ctx = clientContext();
	await plugin.apply(ctx);
	const instance = runtime.mount(ctx.cells[0].Component, seatProps(ctx));
	await settle();
	const entries = styles(instance.tree).flatMap((style) => Object.entries(style));
	assert.ok(entries.length > 0, "the card styles itself");
	for (const [property, value] of entries) {
		const text = String(value);
		for (const reference of text.matchAll(/var\((--[a-z0-9-]+)\)/gu)) {
			assert.match(reference[1], /^--dsw-alias-/u, `${reference[1]} is not a theme token`);
		}
		if (!/color|background/iu.test(property)) continue;
		assert.ok(!/#|rgba?\(|hsla?\(/iu.test(text), `${property}: ${text} must not be a literal colour`);
		assert.ok(text === "transparent" || text === "none" || /var\(--dsw-alias-/u.test(text), `${property}: ${text} must be a theme token`);
	}
});

// --- what the card does ------------------------------------------------------

test("the action writes, then reads back, so the card reports the Host's answer", async () => {
	const calls = hostDouble((body, path) => {
		if (path === plugin.ROUTES_ROUTE) return LISTED;
		if (body.action === "apply") return {
			...drifting(),
			action: "apply",
			written: true
		};
		return body.action === "preview" && calls.some((call) => call.body?.action === "apply") ? current() : drifting();
	});
	const ctx = clientContext();
	await plugin.apply(ctx);
	const instance = runtime.mount(ctx.cells[0].Component, seatProps(ctx));
	await settle();
	const [button] = elements(instance.tree, "button");
	assert.equal(texts(button)[0], "同步到配置");
	button.props.onClick();
	await settle();
	await settle();

	assert.deepEqual(calls.filter((call) => call.path === plugin.SYNC_ROUTE).map((call) => call.body.action), ["preview", "apply", "preview"], "one click previews, writes, and confirms");
	const shown = texts(instance.tree);
	assert.ok(shown.some((text) => text.includes("已写入 1 个模型")), "the write is reported");
	assert.ok(shown.some((text) => text.includes("已是最新")), "and the confirmation comes from a fresh read");
});

test("a route that does not drift is re-read, never written", async () => {
	const calls = hostDouble((body, path) => (path === plugin.ROUTES_ROUTE ? LISTED : current()));
	const ctx = clientContext();
	await plugin.apply(ctx);
	const instance = runtime.mount(ctx.cells[0].Component, seatProps(ctx));
	await settle();
	elements(instance.tree, "button")[0].props.onClick();
	await settle();
	assert.deepEqual(calls.filter((call) => call.path === plugin.SYNC_ROUTE).map((call) => call.body.action), ["preview", "preview"], "no apply is ever sent when there is nothing to write");
});

test("a failed write keeps the failure on screen and offers the action again", async () => {
	let written = false;
	hostDouble((body, path) => {
		if (path === plugin.ROUTES_ROUTE) return LISTED;
		if (body.action === "apply") {
			written = true;
			return {
				ok: false,
				kind: "conflict",
				message: "the configuration changed since it was read, so nothing was written — run the sync again"
			};
		}
		return drifting();
	});
	const ctx = clientContext();
	await plugin.apply(ctx);
	const instance = runtime.mount(ctx.cells[0].Component, seatProps(ctx));
	await settle();
	elements(instance.tree, "button")[0].props.onClick();
	await settle();
	await settle();
	const shown = texts(instance.tree);
	assert.equal(written, true, "the write was attempted");
	assert.ok(shown.some((text) => text.includes("changed since it was read")), "the conflict is explained");
	assert.equal(texts(elements(instance.tree, "button")[0])[0], "重新检查", "a refused write is not retried by itself: the plan is gone, so the action re-reads");
});

test("a request that never reaches the Host is a failure, not an empty card", async () => {
	hostDouble(() => LISTED);
	const ctx = clientContext();
	await plugin.apply(ctx);
	globalThis.fetch = async () => {
		throw new Error("Failed to fetch");
	};
	const instance = runtime.mount(ctx.cells[0].Component, seatProps(ctx));
	await settle();
	assert.ok(texts(instance.tree).some((text) => text.includes("Failed to fetch")));
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
