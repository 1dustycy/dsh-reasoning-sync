/**
 * The sync operation: read the route, read the endpoint catalog, plan, and —
 * only when asked to apply — write the declarations back through the settings
 * service.
 *
 * Everything this module touches is injected, so the same code path runs
 * against the running application and against doubles in a plain Node process
 * (`test/sync.test.mjs`). Two rules hold on every path:
 *
 * 1. **the path ops name `reasoningEfforts` and nothing else** — a model row is
 *    addressed by index and only that one field is set, so `name`,
 *    `contextWindow`, `maxTokens`, `input` and `compat` ride through untouched;
 * 2. **a failure writes no ops at all** — every failure is classified and
 *    returned before the mutation, and a mutation that the settings service
 *    refuses is reported, never retried against a stale revision.
 *
 * Vocabulary follows `CONTEXT.md`: 同步 / 计划 / 判定 / 凭据 / 写入 /
 * revision 冲突.
 *
 * @module dsh-reasoning-sync/sync
 */

import { planReasoningSync } from "./plan.js";

/** How a run is triggered; `preview` reads and plans, `apply` also writes. */
export const ACTIONS = ["preview", "apply"];

/**
 * How long the endpoint catalog read may take before the sync gives up.
 *
 * A timeout is one of the failures the spec names, and a request that never
 * settles is the one failure a user cannot act on: nothing is written either
 * way, but "the endpoint did not answer" says what to try next.
 */
export const CATALOG_TIMEOUT_MS = 15_000;

/** The settings entry field a route lives under. */
const PROVIDERS = "providers";

/**
 * Build one failure result.
 * @param kind - the failure class.
 * @param message - the reason, phrased for the person reading the card.
 * @param extra - further fields to carry (status, provider).
 * @returns the result the caller sees.
 */
function fail(kind, message, extra = {}) {
	return {
		ok: false,
		kind,
		message,
		...extra
	};
}

/**
 * Resolve one credential reference the way the adapter does: the credentials
 * service first, then the environment the host was launched with. An empty
 * value is absent on both sides — a blank never masquerades as a key.
 * @param credentials - the Host credentials service, if the profile has one.
 * @param environment - the launch environment (`{ get }`), for the fallback.
 * @param ref - the credential reference, e.g. `OPENROUTER_API_KEY`.
 * @returns the resolved value, or `undefined`.
 */
async function resolveCredential(credentials, environment, ref) {
	const stored = credentials === void 0 ? void 0 : (await credentials.resolve(ref))?.value;
	if (typeof stored === "string" && stored.length > 0) return stored;
	const launched = environment?.get?.(ref);
	return typeof launched === "string" && launched.length > 0 ? launched : void 0;
}

/**
 * Find the settings entry that declares a route, and read the route as the
 * adapter sees it.
 *
 * The entry is discovered rather than hardcoded: the route's home is whichever
 * settings namespace holds `providers.<route>`, so a profile that renames or
 * relocates the adapter entry keeps working. The revision returned here is the
 * one the write will be checked against, which is what makes a concurrent edit
 * a conflict instead of a silent overwrite.
 * @param settings - the Host settings service.
 * @param provider - the provider route key.
 * @returns the route's home and contents, or a failure result.
 */
async function readRoute(settings, provider) {
	if (settings === void 0 || typeof settings.describe !== "function") return fail("unavailable", "this profile has no settings service, so there is nothing to sync");
	let descriptors;
	try {
		descriptors = await settings.describe();
	} catch (error) {
		return fail("unavailable", `the settings service could not be read: ${String(error?.message ?? error)}`);
	}
	const home = (Array.isArray(descriptors) ? descriptors : []).find((descriptor) => {
		const profile = descriptor?.value?.[PROVIDERS]?.[provider];
		return profile !== null && typeof profile === "object" && !Array.isArray(profile);
	});
	if (home === void 0) return fail("no-route", `no settings entry declares the provider route "${provider}"`);
	const profile = home.value[PROVIDERS][provider];
	if (typeof profile.baseURL !== "string" || profile.baseURL === "") return fail("no-route", `provider route "${provider}" declares no baseURL, so its catalog cannot be read`, { provider });
	return {
		ok: true,
		ns: home.ns,
		revision: home.revision,
		provider,
		profile
	};
}

/**
 * Read the endpoint catalog for one route.
 * @param options.credentials - the Host credentials service, if any.
 * @param options.environment - the launch environment, for the key fallback.
 * @param options.request - the fetch implementation.
 * @param options.route - the route, as {@link readRoute} returned it.
 * @param options.timeoutMs - how long the request may take.
 * @returns the catalog's `data` array, or a failure result.
 */
async function readCatalog({ credentials, environment, request, route, timeoutMs }) {
	const ref = typeof route.profile.apiKeyEnv === "string" && route.profile.apiKeyEnv !== "" ? route.profile.apiKeyEnv : void 0;
	if (ref === void 0) return fail("no-credential", `provider route "${route.provider}" names no apiKeyEnv, so there is no credential to read its catalog with`, { provider: route.provider });
	const key = await resolveCredential(credentials, environment, ref);
	if (key === void 0) return fail("no-credential", `provider route "${route.provider}" resolves ${ref}, which is not set — store it in the credentials service or export it before syncing`, { provider: route.provider });
	const url = `${route.profile.baseURL.replace(/\/+$/u, "")}/models`;
	const signal = typeof globalThis.AbortSignal?.timeout === "function" ? globalThis.AbortSignal.timeout(timeoutMs) : void 0;
	let response;
	try {
		response = await request(url, {
			headers: {
				accept: "application/json",
				authorization: `Bearer ${key}`
			},
			...signal === void 0 ? {} : { signal }
		});
	} catch (error) {
		return fail("transport", `the catalog request to ${url} failed: ${String(error?.message ?? error)}`, { provider: route.provider });
	}
	if (response?.ok !== true) {
		const status = typeof response?.status === "number" ? response.status : void 0;
		return fail("endpoint", `${url} answered ${String(status ?? "without a status")}`, {
			provider: route.provider,
			...status === void 0 ? {} : { status }
		});
	}
	let body;
	try {
		body = await response.json();
	} catch (error) {
		return fail("catalog", `${url} answered with a body that is not JSON: ${String(error?.message ?? error)}`, { provider: route.provider });
	}
	if (!Array.isArray(body?.data)) return fail("catalog", `${url} answered without a catalog: the body carries no \`data\` array`, { provider: route.provider });
	return {
		ok: true,
		data: body.data
	};
}

/**
 * Turn one changing verdict into the path op that lands it.
 *
 * `clear` writes `false` — the adapter's non-reasoning form; an empty
 * declaration is rejected outright (ADR-0002). Nothing here ever writes `off`.
 * @param verdict - an `update` or `clear` verdict.
 * @param index - the model's index in the route's `models` array.
 * @param provider - the provider route key.
 * @returns the settings path op.
 */
function opFor(verdict, index, provider) {
	return {
		op: "set",
		path: [
			PROVIDERS,
			provider,
			"models",
			index,
			"reasoningEfforts"
		],
		value: verdict.kind === "clear" ? false : verdict.efforts
	};
}

/**
 * Classify a refused write.
 *
 * The conflict is recognised by its stable machine code rather than by
 * importing the settings package: a profile plugin cannot resolve the
 * application's own modules, and `SETTINGS_CONFLICT` exists precisely so a
 * caller outside that package can tell it apart.
 * @param error - what the settings service threw.
 * @param provider - the provider route key.
 * @returns the failure result.
 */
function writeFailure(error, provider) {
	const message = String(error?.message ?? error);
	if (error?.code === "SETTINGS_CONFLICT") return fail("conflict", `the configuration changed since it was read, so nothing was written — run the sync again: ${message}`, { provider });
	return fail("unwritable", `the configuration refused the write, so nothing was written: ${message}`, { provider });
}

/**
 * Build the sync operation.
 * @param deps.settings - the Host settings service (`describe` / `mutate`).
 * @param deps.credentials - the Host credentials service (`resolve`), when the profile has one.
 * @param deps.request - the fetch implementation to read the catalog with.
 * @param deps.environment - the launch environment, `{ get(ref) }`, for the key fallback.
 * @param deps.timeoutMs - how long the catalog read may take; defaults to {@link CATALOG_TIMEOUT_MS}.
 * @returns the operation, with a single `run` entry point for both callers.
 */
export function createReasoningSync({ settings, credentials, request, environment, timeoutMs = CATALOG_TIMEOUT_MS }) {
	const send = request ?? ((...args) => globalThis.fetch(...args));
	const launchedWith = environment ?? { get: (ref) => (typeof process === "undefined" ? void 0 : process.env?.[ref]) };

	/**
	 * Run one sync.
	 * @param input.provider - the provider route key to sync.
	 * @param input.action - `preview` to read and plan, `apply` to also write.
	 * Defaults to `preview`: a caller that forgets the action gets a dry run, so
	 * writing is always asked for.
	 * @returns the plan, the changed models, and whether anything was written.
	 */
	async function run({ provider, action = "preview" } = {}) {
		if (typeof provider !== "string" || provider === "") return fail("no-route", "a sync needs the provider route to sync");
		if (!ACTIONS.includes(action)) return fail("action", `unknown action "${String(action)}": expected one of ${ACTIONS.join(", ")}`, { provider });
		const route = await readRoute(settings, provider);
		if (route.ok !== true) return route;
		const catalog = await readCatalog({
			credentials,
			environment: launchedWith,
			request: send,
			route,
			timeoutMs
		});
		if (catalog.ok !== true) return catalog;
		const models = Array.isArray(route.profile.models) ? route.profile.models : [];
		const verdicts = planReasoningSync(catalog.data, models);
		// The write addresses a model by its index, so the index is read once here
		// with the same first-wins rule the plan uses for a duplicated id.
		const indexById = new Map();
		models.forEach((model, index) => {
			const id = model?.id;
			if (typeof id === "string" && id !== "" && !indexById.has(id)) indexById.set(id, index);
		});
		const changing = verdicts.flatMap((verdict) => {
			if (verdict.kind === "keep") return [];
			const index = indexById.get(verdict.id);
			return index === void 0 ? [] : [{
				verdict,
				index
			}];
		});
		const result = {
			ok: true,
			provider,
			action,
			verdicts,
			changes: changing.map(({ verdict }) => verdict.id),
			written: false
		};
		if (action === "preview" || changing.length === 0) return result;
		try {
			await settings.mutate(route.ns, changing.map(({ verdict, index }) => opFor(verdict, index, provider)), route.revision);
		} catch (error) {
			return writeFailure(error, provider);
		}
		return {
			...result,
			written: true
		};
	}

	return { run };
}
