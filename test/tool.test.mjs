/**
 * The agent tool's model-facing surface.
 *
 * What the model sees is the tool's name, description, parameter schema, and
 * the text a result renders to — so that is what this suite pins. The operation
 * behind it is covered by `test/sync.test.mjs`; here the operation is a double,
 * which is what proves the tool owns no sync logic of its own.
 *
 * Run with `node test/tool.test.mjs`.
 */

import assert from "node:assert/strict";
import { TOOL_NAME, textOf, toolDefinition } from "../lib/tool.js";

let passed = 0;
const failures = [];
const cases = [];

/** Register one named test; failures are collected instead of stopping the run. */
function test(title, body) {
	cases.push({ title, body });
}

/** A tool bound to a double that records what it was asked and answers once. */
function harness(answer = { ok: true }) {
	const asked = [];
	const tool = toolDefinition(async (input) => {
		asked.push(input);
		return answer;
	});
	return {
		asked,
		tool,
		text: (value) => tool.output.render({}, value)[0].text
	};
}

test("the tool carries the plugin's own name and a description of its limits", () => {
	const { tool } = harness();
	assert.equal(tool.name, TOOL_NAME);
	assert.match(tool.description, /reasoningEfforts/u, "the description says which field it writes");
	assert.match(tool.description, /never adds, removes, or reorders/u, "and what it refuses to do to model rows");
});

test("the provider is required and the action is a closed choice", () => {
	const { tool } = harness();
	assert.deepEqual(tool.parameters.required, ["provider"]);
	assert.deepEqual(tool.parameters.properties.action.enum, ["preview", "apply"]);
	assert.equal(tool.parameters.additionalProperties, false, "an unknown argument is a mistake, not an extension");
});

test("the tool passes its arguments straight to the one operation", async () => {
	const { tool, asked } = harness();
	await tool.execute({
		provider: "openrouter-live",
		action: "preview"
	});
	assert.deepEqual(asked, [{
		provider: "openrouter-live",
		action: "preview"
	}]);
});

test("a call with no arguments still reaches the operation, which refuses it", async () => {
	const { tool, asked } = harness();
	await tool.execute(void 0);
	assert.deepEqual(asked, [{}], "the operation owns validation, so it must be the one to see the empty call");
});

// --- what the model reads ----------------------------------------------------

test("a preview says what it would write, per model", () => {
	const { text } = harness();
	const rendered = text({
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
					high: "high"
				},
				capability: {
					levels: ["low", "high"],
					unknown: [],
					mandatory: true
				}
			}
		]
	});
	assert.match(rendered, /reasoning_sync preview for "openrouter-live"/u);
	assert.match(rendered, /would write 1 of 2 declared models/u);
	assert.match(rendered, /update openai\/gpt-6\.1-sol: declared high → endpoint low, high/u, "both sides of the difference are named, in declaration order");
	assert.ok(!rendered.includes("keep   stealth"), "a kept model that needs no explanation stays out of the way");
});

test("a dropped off key is reported, not slipped in", () => {
	const { text } = harness();
	const rendered = text({
		ok: true,
		provider: "openrouter-live",
		action: "apply",
		written: true,
		changes: ["openai/gpt-6.1-sol"],
		verdicts: [{
			id: "openai/gpt-6.1-sol",
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
		}]
	});
	assert.match(rendered, /dropped off: the endpoint says reasoning is mandatory/u);
});

test("a run that writes says so", () => {
	const { text } = harness();
	const rendered = text({
		ok: true,
		provider: "openrouter-live",
		action: "apply",
		written: true,
		changes: ["openai/gpt-6.1-sol"],
		verdicts: [{
			id: "openai/gpt-6.1-sol",
			kind: "clear",
			reason: "non-reasoning",
			declared: { high: "high" },
			capability: {
				levels: [],
				unknown: [],
				mandatory: false
			}
		}]
	});
	assert.match(rendered, /wrote 1 of 1 declared models/u);
	assert.match(rendered, /clear {2}openai\/gpt-6\.1-sol: declared high → reasoningEfforts: false/u, "a clear names both what was declared and the value it writes");
});

test("an in-sync route reads as nothing to do, not as a silent success", () => {
	const { text } = harness();
	const rendered = text({
		ok: true,
		provider: "openrouter-live",
		action: "apply",
		written: false,
		changes: [],
		verdicts: [{
			id: "openai/gpt-6.1-sol",
			kind: "keep",
			reason: "in-sync",
			capability: {
				levels: ["high"],
				unknown: [],
				mandatory: false
			}
		}]
	});
	assert.match(rendered, /nothing drifts/u);
});

test("levels the adapter does not know are reported as left alone", () => {
	const { text } = harness();
	const rendered = text({
		ok: true,
		provider: "openrouter-live",
		action: "apply",
		written: false,
		changes: [],
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
	});
	assert.match(rendered, /does not know \(left alone\): openai\/gpt-6\.1-sol: ultra/u);
});

test("a failure keeps its class and its reason", () => {
	const { text } = harness();
	const rendered = text({
		ok: false,
		kind: "conflict",
		message: "the configuration changed since it was read, so nothing was written — run the sync again"
	});
	assert.match(rendered, /reasoning_sync failed \(conflict\)/u);
	assert.match(rendered, /changed since it was read/u);
});

test("rendering survives a result with nothing in it", () => {
	const { text } = harness();
	assert.doesNotThrow(() => text(void 0));
	assert.doesNotThrow(() => text({
		ok: true,
		verdicts: [],
		changes: []
	}));
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
