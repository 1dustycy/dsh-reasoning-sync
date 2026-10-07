/**
 * S1 — the plan function, exhaustively.
 *
 * Everything here is pure: a catalog shaped like OpenRouter's `GET /models`
 * `data` array goes in, verdicts come out. No network, no credentials, no
 * settings. The point of the table is to pin the mapping rules for *every*
 * shape the endpoint can publish, including the ones that must change nothing.
 *
 * Run with `node test/plan.test.mjs`.
 */

import assert from "node:assert/strict";
import { LEVELS, planReasoningSync } from "../lib/plan.js";

let passed = 0;
const failures = [];
/** Registered cases, run one at a time before the report. */
const cases = [];

/** Register one named test; failures are collected instead of stopping the run. */
function test(title, body) {
	cases.push({ title, body });
}

/**
 * One catalog entry as OpenRouter publishes it.
 * @param id - model id.
 * @param reasoning - the `reasoning` block, or undefined to omit the field entirely.
 * @returns a catalog entry.
 */
function entry(id, reasoning) {
	return reasoning === void 0 ? { id, name: id } : {
		id,
		name: id,
		reasoning
	};
}

/**
 * A capability block with the fields the endpoint actually sends.
 * @param efforts - `supported_efforts`.
 * @param extra - `mandatory` / `default_effort` overrides.
 * @returns the `reasoning` block.
 */
function reasoning(efforts, extra = {}) {
	return {
		mandatory: false,
		default_enabled: true,
		supported_efforts: efforts,
		default_effort: efforts[0],
		...extra
	};
}

/** One declared model entry, with the fields the plan must ignore left in place. */
function model(id, reasoningEfforts) {
	return {
		id,
		name: `Name of ${id}`,
		contextWindow: 1000,
		maxTokens: 100,
		input: ["text"],
		...reasoningEfforts === void 0 ? {} : { reasoningEfforts }
	};
}

/** The only verdict for one model; fails when the plan has more or fewer. */
function only(plan, id) {
	const verdicts = plan.filter((verdict) => verdict.id === id);
	assert.equal(verdicts.length, 1, `exactly one verdict for ${id}`);
	return verdicts[0];
}

// --- the mapping rules -------------------------------------------------------

/**
 * Every positive level the endpoint publishes is declared under its own name.
 * `none` is not a level: it is the wire value for "reasoning off", which has no
 * safe declaration here, so it is dropped rather than mapped.
 */
test("positive levels pass through by name, in escalation order, and drop none", () => {
	const plan = planReasoningSync(
		[entry("m", reasoning(["high", "none", "low", "max"]))],
		[model("m", { high: "high" })],
	);
	const verdict = only(plan, "m");
	assert.equal(verdict.kind, "update");
	assert.deepEqual(Object.keys(verdict.efforts), ["low", "high", "max"], "declaration order follows the adapter's escalation order, with none dropped");
	assert.deepEqual(verdict.efforts, {
		low: "low",
		high: "high",
		max: "max"
	}, "each surviving level is declared under its own name");
	assert.ok(!Object.keys(verdict.efforts).includes("off"), "off is never generated");
	assert.ok(!Object.values(verdict.efforts).includes("none"), "none is never sent as a wire value");
});

test("the verdict carries the inputs it was derived from", () => {
	const plan = planReasoningSync(
		[entry("m", reasoning(["high", "sage"], { mandatory: true, default_effort: "high" }))],
		[model("m", { high: "high" })],
	);
	const verdict = only(plan, "m");
	assert.deepEqual(verdict.declared, { high: "high" }, "the current declaration is reported verbatim");
	assert.deepEqual(verdict.capability, {
		levels: ["high"],
		unknown: ["sage"],
		mandatory: true,
		defaultEffort: "high",
	});
});

test("a model already declaring exactly the published levels is kept", () => {
	const plan = planReasoningSync(
		[entry("m", reasoning(["low", "high"]))],
		[model("m", { low: "low", high: "high" })],
	);
	const verdict = only(plan, "m");
	assert.equal(verdict.kind, "keep");
	assert.equal(verdict.reason, "in-sync");
});

test("an update replaces the whole declaration, dropping levels the endpoint withdrew", () => {
	const plan = planReasoningSync(
		[entry("m", reasoning(["high"]))],
		[model("m", {
			low: "low",
			high: "high",
		})],
	);
	const verdict = only(plan, "m");
	assert.equal(verdict.kind, "update");
	assert.deepEqual(verdict.efforts, { high: "high" }, "a withdrawn level is removed, not retained");
});

test("an existing off declaration survives an update, and is never invented", () => {
	const plan = planReasoningSync(
		[entry("m", reasoning(["high"]))],
		[model("m", { off: null })],
	);
	assert.deepEqual(only(plan, "m").efforts, {
		off: null,
		high: "high"
	}, "off is neither added nor removed while the endpoint leaves reasoning optional");

	const without = planReasoningSync([entry("m", reasoning(["high"]))], [model("m", {})]);
	assert.deepEqual(only(without, "m").efforts, { high: "high" }, "no off key appears from nowhere");
});

test("an off declaration is dropped, and reported, when the endpoint says reasoning is mandatory", () => {
	const plan = planReasoningSync(
		[entry("m", reasoning(["high"], { mandatory: true }))],
		[model("m", {
			off: null,
			high: "high"
		})],
	);
	const verdict = only(plan, "m");
	assert.equal(verdict.kind, "update", "the declaration still changes: the unsafe key goes");
	assert.deepEqual(verdict.efforts, { high: "high" }, "off is what makes an unselected level dispatch `none` — the 400 this plugin exists to avoid");
	assert.deepEqual(verdict.removed, ["off"], "and the removal is reported rather than silent");
});

test("a declaration that is only off still gains the published levels", () => {
	const plan = planReasoningSync([entry("m", reasoning(["high"]))], [model("m", { off: "none" })]);
	assert.deepEqual(only(plan, "m").efforts, {
		off: "none",
		high: "high"
	}, "an endpoint that leaves reasoning optional keeps the user's own choice of wire value");
});

test("a model already declaring false and still non-reasoning is kept", () => {
	const plan = planReasoningSync([entry("m", reasoning([]))], [model("m", false)]);
	const verdict = only(plan, "m");
	assert.equal(verdict.kind, "keep");
	assert.equal(verdict.reason, "in-sync");
});

// --- unknown is not non-reasoning -------------------------------------------

/** A model the endpoint never mentions must keep whatever it declares. */
test("a model the endpoint never published is unknown, not non-reasoning", () => {
	const plan = planReasoningSync([], [model("m", { high: "high" })]);
	const verdict = only(plan, "m");
	assert.equal(verdict.kind, "keep");
	assert.equal(verdict.reason, "cloaked");
	assert.deepEqual(verdict.declared, { high: "high" });
});

test("a catalog entry with no reasoning field at all is unknown", () => {
	const plan = planReasoningSync([entry("m")], [model("m", { high: "high" })]);
	const verdict = only(plan, "m");
	assert.equal(verdict.kind, "keep");
	assert.equal(verdict.reason, "unknown");
	assert.equal(verdict.capability, null, "an unpublished capability is not an empty one");
});

// --- non-reasoning is a positive statement ----------------------------------

test("a published capability with no positive level clears the declaration", () => {
	for (const efforts of [[], ["none"]]) {
		const plan = planReasoningSync([entry("m", reasoning(efforts))], [model("m", { high: "high" })]);
		const verdict = only(plan, "m");
		assert.equal(verdict.kind, "clear", `${JSON.stringify(efforts)} is a non-reasoning statement`);
		assert.equal(verdict.reason, "non-reasoning");
		assert.equal(verdict.efforts, void 0, "clear carries no level set");
	}
});

test("clear applies to a model that never declared anything, too", () => {
	const plan = planReasoningSync([entry("m", reasoning([]))], [model("m")]);
	assert.equal(only(plan, "m").kind, "clear");
});

// --- levels the adapter does not know ---------------------------------------

test("a level the adapter does not know is reported, never guessed at", () => {
	const plan = planReasoningSync([entry("m", reasoning(["ultra"]))], [model("m", { high: "high" })]);
	const verdict = only(plan, "m");
	assert.equal(verdict.kind, "keep", "an unmappable capability must not be written as an empty declaration");
	assert.equal(verdict.reason, "unmappable", "and it is not `unknown`: the endpoint did publish something");
	assert.deepEqual(verdict.capability.unknown, ["ultra"]);
});

test("known levels are written while unknown ones are reported alongside", () => {
	const plan = planReasoningSync([entry("m", reasoning(["high", "ultra"]))], [model("m", {})]);
	const verdict = only(plan, "m");
	assert.equal(verdict.kind, "update");
	assert.deepEqual(verdict.efforts, { high: "high" }, "the known half is still synced");
	assert.deepEqual(verdict.capability.unknown, ["ultra"], "the unknown half is reported, not mapped");
});

test("a model whose levels are all unknown keeps its declaration and says why", () => {
	const declared = { turbo: "turbo" };
	const plan = planReasoningSync([entry("m", reasoning(["ultra", "hyper"]))], [model("m", declared)]);
	const verdict = only(plan, "m");
	assert.equal(verdict.kind, "keep");
	assert.deepEqual(verdict.declared, declared);
	assert.deepEqual(verdict.capability.unknown, ["ultra", "hyper"]);
});

// --- shape of the plan itself ------------------------------------------------

test("the plan covers every declared model, in declaration order", () => {
	const plan = planReasoningSync(
		[entry("b", reasoning(["high"])), entry("a", reasoning(["high"])), entry("c", reasoning([]))],
		[model("b"), model("a"), model("c"), model("d", { high: "high" })],
	);
	assert.deepEqual(plan.map((verdict) => verdict.id), ["b", "a", "c", "d"], "verdicts follow the configured route, not the catalog");
	assert.deepEqual(plan.map((verdict) => verdict.kind), ["update", "update", "clear", "keep"]);
});

test("a malformed catalog or model list plans nothing instead of throwing", () => {
	assert.deepEqual(planReasoningSync(void 0, void 0), []);
	assert.deepEqual(planReasoningSync(null, null), []);
	assert.deepEqual(planReasoningSync({ data: [] }, []), [], "a catalog wrapped in data is not a catalog");
	assert.deepEqual(planReasoningSync([], [{ name: "no id" }]), [], "an entry without an id cannot be addressed");
	assert.deepEqual(planReasoningSync([{ id: 7 }, entry("m", reasoning([]))], [model("m", { high: "high" })]), [{
		id: "m",
		kind: "clear",
		reason: "non-reasoning",
		capability: {
			levels: [],
			unknown: [],
			mandatory: false
		},
		declared: { high: "high" }
	}], "a catalog entry with no usable id is ignored, not treated as this model");
});

test("a verdict is lossless JSON, so neither end has to read past an undefined", () => {
	const plan = planReasoningSync([entry("m", reasoning(["high"]))], [model("m")]);
	const roundTripped = JSON.parse(JSON.stringify(plan));
	assert.deepEqual(roundTripped, plan, "a verdict survives the wire unchanged");
	for (const verdict of plan) {
		for (const [key, value] of Object.entries(verdict)) assert.notEqual(value, void 0, `${verdict.id}.${key} is never undefined`);
		for (const [key, value] of Object.entries(verdict.capability ?? {})) assert.notEqual(value, void 0, `${verdict.id}.capability.${key} is never undefined`);
	}
});

test("a duplicate catalog id resolves to the first published entry", () => {
	const plan = planReasoningSync(
		[entry("m", reasoning(["high"])), entry("m", reasoning([]))],
		[model("m", {})],
	);
	assert.equal(only(plan, "m").kind, "update", "the first entry wins");
});

test("every level the adapter declares is mappable", () => {
	const plan = planReasoningSync([entry("m", reasoning(LEVELS))], [model("m", {})]);
	assert.deepEqual(only(plan, "m").efforts, Object.fromEntries(LEVELS.map((level) => [level, level])));
});

for (const { title, body } of cases) {
	try {
		body();
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
