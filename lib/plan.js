/**
 * The plan: what one route's declared models should say about reasoning, given
 * what the endpoint publishes.
 *
 * This module is pure on purpose — no credentials, no requests, no settings —
 * because the mapping is where a wrong answer is expensive: a level written
 * under the wrong name, or an `off` key invented, produces a configuration the
 * adapter either rejects or silently mis-dispatches. A pure function is the one
 * seam where every shape the endpoint can publish is enumerable in a table
 * (see `test/plan.test.mjs`).
 *
 * Vocabulary is fixed by `CONTEXT.md`: 端点目录 / 能力 / 等级声明 / 等级 /
 * 判定 / 未知 / 不认识 / 非推理 / cloaked 模型 / 不写 off. The three "leave it
 * alone" outcomes are deliberately distinct reasons — `unknown` (the endpoint
 * said nothing), `unmappable` (it said something this adapter cannot read) and
 * `cloaked` (the catalog does not list the model) — because a reader who cannot
 * tell them apart cannot tell a gap in the endpoint from a gap in this plugin.
 *
 * @module dsh-reasoning-sync/plan
 */

/**
 * Every level the pi-ai adapter knows, in escalation order.
 *
 * The adapter's own list is `THINKING_LEVELS` (`off` first, then these six);
 * `off` is deliberately absent here because it is not a level — it is the slot
 * that decides what an unselected level dispatches, and writing it is the one
 * thing this plugin must never do. See `CONTEXT.md` → 不写 off.
 */
export const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Whether a value is a level declaration rather than the non-reasoning form.
 * @param value - a `reasoningEfforts` value.
 * @returns true for a plain object.
 */
function isDeclaration(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read one model entry's current declaration.
 * @param model - a configured model entry.
 * @returns the declaration value, or `undefined` when the field is absent.
 */
function declaredOf(model) {
	const declared = model.reasoningEfforts;
	return isDeclaration(declared) ? { ...declared } : declared;
}

/**
 * Read the capability one catalog entry publishes.
 *
 * A capability is an *observation*, not configuration: it says which levels the
 * endpoint accepts, whether reasoning can be turned off, and where an
 * unselected level lands. `none` is dropped here rather than in the mapping,
 * because "reasoning off" is not a level the adapter can declare.
 * @param entry - one `data` element of the endpoint catalog.
 * @returns the capability, or `null` when the entry publishes no `reasoning` field.
 */
function capabilityOf(entry) {
	const block = entry?.reasoning;
	if (block === null || typeof block !== "object" || Array.isArray(block)) return null;
	const published = Array.isArray(block.supported_efforts) ? block.supported_efforts.filter((effort) => typeof effort === "string") : [];
	const defaultEffort = typeof block.default_effort === "string" ? block.default_effort : void 0;
	return {
		levels: LEVELS.filter((level) => published.includes(level)),
		unknown: [...new Set(published.filter((effort) => effort !== "none" && !LEVELS.includes(effort)))],
		mandatory: block.mandatory === true,
		...defaultEffort === void 0 ? {} : { defaultEffort }
	};
}

/**
 * Index a catalog by model id. The first entry for an id wins: a duplicated id
 * is an endpoint anomaly, and the first is the one a caller reading the list
 * top-down would see.
 * @param catalog - the endpoint catalog, i.e. `GET /models`'s `data` array.
 * @returns model id → capability (`null` for an entry with no `reasoning` field).
 */
function catalogById(catalog) {
	const byId = new Map();
	if (!Array.isArray(catalog)) return byId;
	for (const entry of catalog) {
		const id = entry?.id;
		if (typeof id !== "string" || id === "" || byId.has(id)) continue;
		byId.set(id, capabilityOf(entry));
	}
	return byId;
}

/**
 * Build the declaration the endpoint's levels call for.
 *
 * Same-name passthrough, in escalation order, plus the one existing key the
 * mapping is not allowed to invent: `off`. An `off` the user already declared
 * rides along untouched — **unless** the endpoint publishes the model as
 * mandatory, in which case it is dropped. That is not an exception to "never
 * off" but its whole point: `off` is what makes an unselected level dispatch
 * `reasoning: { effort: "none" }`, and a mandatory endpoint answers that with
 * 400 — so re-emitting it on a sync would write back exactly the configuration
 * that fails. See ADR-0002 and ADR-0005.
 * @param levels - the recognized levels, escalation order.
 * @param declared - the model's current declaration.
 * @param capability - what the endpoint publishes for this model.
 * @returns the declaration to write.
 */
function declarationFor(levels, declared, capability) {
	const efforts = {};
	if (isDeclaration(declared) && "off" in declared && capability.mandatory !== true) efforts.off = declared.off;
	for (const level of LEVELS) if (levels.includes(level)) efforts[level] = level;
	return efforts;
}

/**
 * The declared keys a write drops rather than carries.
 * @param declared - the model's current declaration.
 * @param capability - what the endpoint publishes for this model.
 * @returns the dropped keys, empty when nothing is dropped.
 */
function droppedBy(declared, capability) {
	return isDeclaration(declared) && "off" in declared && capability.mandatory === true ? ["off"] : [];
}

/**
 * Whether a model already says exactly what the endpoint calls for.
 * @param declared - the model's current declaration.
 * @param target - the declaration {@link declarationFor} built.
 * @returns true when the two are the same declaration.
 */
function sameDeclaration(declared, target) {
	if (!isDeclaration(declared)) return false;
	const keys = Object.keys(target);
	return Object.keys(declared).length === keys.length && keys.every((key) => declared[key] === target[key]);
}

/**
 * Assemble one verdict.
 *
 * The verdict is lossless JSON on purpose: it crosses the wire from the Host to
 * the card, and that end rejects a value which carries an `undefined`. An absent
 * declaration is therefore an absent key, not a key whose value is `undefined`.
 * @param id - the model's id.
 * @param body - the verdict body.
 * @param declared - the model's current declaration.
 * @returns the verdict.
 */
function verdict(id, body, declared) {
	return {
		id,
		...body,
		...declared === void 0 ? {} : { declared }
	};
}

/**
 * Decide one model.
 * @param id - the model's id.
 * @param declared - its current declaration.
 * @param capability - what the endpoint publishes for it, or `null`.
 * @param published - whether the catalog names this model at all.
 * @returns the verdict.
 */
function verdictFor(id, declared, capability, published) {
	if (capability === null) return verdict(id, {
		kind: "keep",
		reason: published ? "unknown" : "cloaked",
		capability: null
	}, declared);
	if (capability.levels.length === 0) {
		// A capability whose levels this adapter does not know is not a statement
		// that the model cannot reason: it is a statement this plugin does not
		// understand. Clearing on it would delete levels the endpoint still
		// offers, so it keeps its declaration under its own reason — `unmappable`,
		// distinct from `unknown` (no capability published at all). Only a
		// capability with nothing but `none`, or nothing at all, says the model
		// cannot reason. See ADR-0001.
		if (capability.unknown.length > 0) return verdict(id, {
			kind: "keep",
			reason: "unmappable",
			capability
		}, declared);
		if (declared === false) return verdict(id, {
			kind: "keep",
			reason: "in-sync",
			capability
		}, declared);
		return verdict(id, {
			kind: "clear",
			reason: "non-reasoning",
			capability
		}, declared);
	}
	const efforts = declarationFor(capability.levels, declared, capability);
	if (sameDeclaration(declared, efforts)) return verdict(id, {
		kind: "keep",
		reason: "in-sync",
		capability
	}, declared);
	const removed = droppedBy(declared, capability);
	return verdict(id, {
		kind: "update",
		efforts,
		...removed.length === 0 ? {} : { removed },
		capability
	}, declared);
}

/**
 * Plan one route: what each declared model's `reasoningEfforts` should be.
 *
 * Only models the route already declares are planned, and only their level
 * declaration is decided — the verdict is data, never a write. A model the
 * endpoint does not publish keeps its declaration, because a missing report is
 * not a statement of incapability; a model the endpoint explicitly publishes
 * without a declarable level is cleared to the adapter's non-reasoning form.
 * @param catalog - the endpoint catalog, i.e. `GET /models`'s `data` array.
 * @param models - the route's declared model entries.
 * @returns one verdict per addressable model, in declaration order.
 */
export function planReasoningSync(catalog, models) {
	const byId = catalogById(catalog);
	if (!Array.isArray(models)) return [];
	const plan = [];
	for (const model of models) {
		const id = model?.id;
		if (typeof id !== "string" || id === "") continue;
		const declared = declaredOf(model);
		plan.push(verdictFor(id, declared, byId.has(id) ? byId.get(id) : null, byId.has(id)));
	}
	return plan;
}
