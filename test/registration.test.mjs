/**
 * The contract test: what this plugin registers must be admissible to the
 * *real* DSH application, not merely to this repo's idea of one.
 *
 * These bindings are checked against the installed app, each by loading the
 * shipped bytes rather than a copy of them — a copy would drift, and this suite
 * exists precisely to catch a binding the shipped validator rejects:
 *
 * 1. **the seat** — the Models settings page declares `settings.models.provider-card`
 *    as a keyed child slot. The suite lifts that declaration out of the shipped
 *    page, feeds it to the shipped slot registry, and registers this plugin's own
 *    claim through the shipped `register()` — so the claim is judged by the same
 *    code the page will judge it with.
 * 2. **the seat key** — a keyed cell is dispatched by the settings namespace, which
 *    is the adapter entry's id. The suite reads that id out of the shipped bundles
 *    and checks the three shipped statements of it agree.
 * 3. **the bridge** — the card reaches this Host through two exact Connection
 *    Fetch routes, so their paths must survive the fence's own grammar.
 *
 * Without the app installed the suite prints a SKIP line and exits 0, so the repo
 * stays runnable anywhere; a machine with DSH installed is where it earns its keep.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { ROUTES_ROUTE, SYNC_ROUTE } from "../lib/routes.js";

/** Default install location of the macOS application carrying the shipped bundles. */
const APP_ASAR = process.env.DSH_APP_ASAR ?? "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar";

/** Bundle path of the seat's declaring page inside the archive. */
const MODELS_PATH = "dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js";
/** Bundle path of the slot registry the page and this plugin both register through. */
const SLOTS_PATH = "dsh/node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js";
/** Bundle path of the adapter whose settings namespace the seat is keyed by. */
const PI_AI_PATH = "dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js";
/** Patch path of the bundle that mounts that adapter, which owns the entry id. */
const BASE_PATCH_PATH = "dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml";
/** Bundle path of the Connection service, whose Fetch registry carries the card's calls. */
const CONNECTION_PATH = "dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js";

/** The seat this plugin claims, and the shape the page must declare it in. */
const SLOT = "settings.models.provider-card";

/**
 * Open an asar archive for reads by entry path.
 *
 * The data region starts at the next 4-byte boundary after the header JSON, not
 * immediately after it: the two padding bytes in this archive would otherwise be
 * read as the start of every file (they are `">\n"`, which shifts every line by
 * one and makes line numbers quoted from here land one line off). Each entry that
 * carries an integrity hash is verified against it, so a reader that is wrong
 * about the layout fails loudly instead of validating the wrong bytes.
 * @param archive - absolute archive path.
 * @returns the reader.
 */
function openAsar(archive) {
	const buffer = readFileSync(archive);
	const jsonSize = buffer.readUInt32LE(12);
	const header = JSON.parse(buffer.subarray(16, 16 + jsonSize).toString("utf8"));
	const dataStart = (16 + jsonSize + 3) & ~3;
	return {
		/**
		 * Read one entry.
		 * @param target - archive-relative path.
		 * @returns the entry's bytes, or `undefined` when it is absent or unpacked.
		 */
		read(target) {
			let node = header;
			for (const part of target.split("/")) {
				node = node.files?.[part];
				if (node === void 0) return void 0;
			}
			if (node.files !== void 0 || node.unpacked === true) return void 0;
			const bytes = buffer.subarray(dataStart + Number(node.offset), dataStart + Number(node.offset) + node.size);
			const declared = node.integrity?.hash;
			if (declared !== void 0) {
				const actual = createHash(node.integrity.algorithm ?? "sha256").update(bytes).digest("hex");
				if (actual !== declared) throw new Error(`asar read of ${target} failed its integrity hash: the archive layout is not what this reader assumes`);
			}
			return bytes;
		},
		/**
		 * Read one entry as text.
		 * @param target - archive-relative path.
		 * @returns the entry's text, or `undefined` when it is absent.
		 */
		text(target) {
			return this.read(target)?.toString("utf8");
		}
	};
}

/**
 * Load the shipped slot registry, which imports nothing.
 * @param source - the shipped bundle's text.
 * @returns its exports.
 */
function loadSlots(source) {
	const code = source.replace(/^export \{(.+)\};$/mu, "globalThis.__shippedSlots = {$1};");
	if (code === source) throw new Error("the shipped slot registry changed shape: its export line is gone");
	new Function(code)();
	const exports = globalThis.__shippedSlots;
	delete globalThis.__shippedSlots;
	return exports;
}

/**
 * Materialize this repo's client bundle the way the browser does.
 * @param source - the bundle's text.
 * @param context - the client context the bundle's `apply` receives.
 * @returns the bundle's exports.
 */
function loadClient(source, context) {
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
		fetch: context.fetch
	};
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox, { filename: "client.js" });
	assert.equal(registrations.length, 1, "the bundle registers exactly one module");
	return registrations[0].factory((specifier) => {
		if (specifier === "react") return { createElement: (type, props) => ({
			type,
			props
		}) };
		throw new Error(`the bundle must not require ${specifier}`);
	});
}

const archive = existsSync(APP_ASAR) ? openAsar(APP_ASAR) : void 0;
const models = archive?.text(MODELS_PATH);
const slots = archive?.text(SLOTS_PATH);

if (models === void 0 || slots === void 0) {
	console.log(`reasoning-sync: SKIPPED the shipped-app contract — ${APP_ASAR} is not installed on this machine`);
} else {
	// --- 1. the seat, as the page declares it ---------------------------------

	const declaration = /"settings\.models\.provider-card":\s*\{\s*kind:\s*"(\w+)",\s*scope:\s*"(\w+)"/u.exec(models);
	if (declaration === null) throw new Error("the shipped Models page changed shape: its provider-card seat declaration is gone");
	assert.equal(declaration[1], "keyed", "the seat is keyed, so a cell is addressed by key rather than by order");
	assert.equal(declaration[2], "root", "the seat is root-scoped, so its extension sees no session");

	const { SlotCore } = loadSlots(slots);
	const core = new SlotCore();
	core.register({ name: "root", children: { [SLOT]: {
		kind: declaration[1],
		scope: declaration[2]
	} } }, () => null);

	// The seat really is keyed: a claim without a key is refused, which is the
	// property the plugin's own registration depends on.
	assert.throws(() => core.register({ name: SLOT }, () => null), /requires options\.key/u, "the shipped registry enforces the key the page dispatches by");

	// --- 2. the key, as the shipped bundles state it ---------------------------

	const piAi = archive.text(PI_AI_PATH);
	const basePatch = archive.text(BASE_PATCH_PATH);
	if (piAi === void 0 || basePatch === void 0) throw new Error("the shipped adapter or the bundle that mounts it is missing");
	const adapterNamespace = /const NS = "([^"]+)";/u.exec(piAi)?.[1];
	const mountedRowId = /- id: (\S+)\s*\n\s*name: '@deepseek-ai\/dsh-llm-pi-ai'/u.exec(basePatch)?.[1];
	const pageNamespace = /const NS\$1 = "([^"]+)";/u.exec(models)?.[1];
	assert.equal(adapterNamespace, "llm-pi-ai", "the adapter's own settings namespace");
	assert.equal(mountedRowId, adapterNamespace, "the entry that mounts the adapter is the namespace it serves under");
	assert.equal(pageNamespace, adapterNamespace, "the page keys pi-ai rows by that same namespace");

	// --- this plugin's claim, registered by the shipped registry ---------------

	const cells = [];
	const registered = [];
	const plugin = loadClient(readFileSync(fileURLToPath(new URL("../lib/client.js", import.meta.url)), "utf8"), {
		fetch: async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				namespaces: [adapterNamespace],
				routes: [{
					provider: "openrouter-live",
					displayName: "OpenRouter",
					namespace: adapterNamespace
				}]
			})
		})
	});
	await plugin.apply({
		slots: {
			inject(key, callback) {
				assert.equal(key, SLOT, "the Client half waits on the seat it claims");
				callback();
			},
			register(options, Component) {
				registered.push(options);
				cells.push(core.register(options, Component));
			}
		},
		locale: {
			register: () => () => {},
			bind: () => (key) => key
		},
		effect: (body) => body()
	});
	assert.equal(registered.length, 1, "one claim, so the page's one seat has one occupant");
	const [claim] = registered;
	assert.equal(claim.name, SLOT, "the claim names the seat the page declares");
	assert.equal(claim.key, adapterNamespace, "and keys it by the namespace the page dispatches its pi-ai rows with");
	assert.equal(core.entries(SLOT).length, 1, "the shipped registry holds the claim");
	assert.equal(core.entries(SLOT)[0].options.key, adapterNamespace);

	// --- 3. the bridge the card calls through ---------------------------------

	const connection = archive.text(CONNECTION_PATH);
	if (connection === void 0) throw new Error("the shipped Connection bundle is missing");
	assert.match(connection, /createSharedFetchHandler\(API_PATH\)/u, "the shared /api handler is what serves registered Fetch routes");
	const segment = /const ENDPOINT_SEGMENT_PATTERN = (\/\^.*\$\/[a-z]*);/u.exec(connection)?.[1];
	if (segment === void 0) throw new Error("the shipped Connection bundle changed shape: its endpoint segment grammar is gone");
	const pattern = new RegExp(segment.slice(1, segment.lastIndexOf("/")), segment.slice(segment.lastIndexOf("/") + 1));
	for (const route of [SYNC_ROUTE, ROUTES_ROUTE]) {
		assert.ok(route.startsWith("/api/"), `${route} lives under the /api fence`);
		for (const part of route.slice("/api/".length).split("/")) {
			assert.match(part, pattern, `${route} is addressable by the shipped endpoint grammar`);
		}
	}

	console.log(`reasoning-sync: the shipped app declares seat ${SLOT} (keyed, root), dispatches it by ${adapterNamespace}, admits this plugin's claim, and serves its two /api routes`);
}
