/**
 * The agent tool: the same sync operation the card runs, exposed to the model.
 *
 * One operation, two callers (`references/user-actions.md` in the shipped
 * plugin-development skill): this module owns no sync logic, only the tool's
 * model-facing surface — its name, its parameter schema, and how a result reads
 * as text. The operation itself is `lib/sync.js`, so a card click and a tool
 * call cannot drift apart.
 *
 * Two constraints shape the definition:
 *
 * - the registry accepts a raw definition, and a profile plugin **cannot** load
 *   `@deepseek-ai/dsh-tools` to reach `defineTool` (a profile's `node_modules`
 *   holds only profile-installed bundles), so the schema is written as plain
 *   JSON Schema in the subset the registry enforces:
 *   `type/oneOf/properties/required/additionalProperties/items/enum/const` plus
 *   annotations;
 * - a raw registration is **not** argument-checked by the registry, so `execute`
 *   passes whatever arrives to the operation, which validates it.
 *
 * @module dsh-reasoning-sync/tool
 */

import { ACTIONS } from "./sync.js";

/** The model-facing tool name; owned by this plugin and stable across versions. */
export const TOOL_NAME = "reasoning_sync";

/** Human phrasing for each verdict reason the plan can produce. */
const REASONS = {
	"in-sync": "already declares what the endpoint publishes",
	cloaked: "the endpoint catalog does not list it",
	unknown: "the endpoint publishes no reasoning capability for it",
	unmappable: "the endpoint publishes levels this adapter does not know",
	"non-reasoning": "the endpoint publishes no level this adapter can declare"
};

/**
 * Read a declaration side as the levels it offers.
 *
 * `off` is left out on purpose: it is not a level, it is the key that decides
 * what an unselected level dispatches, and naming it here would read as one.
 * @param declared - a verdict's current-declaration side.
 * @returns the levels, or what their absence means.
 */
function levelsOf(declared) {
	if (declared === false) return "non-reasoning";
	if (declared === void 0) return "nothing declared";
	const levels = Object.keys(declared).filter((key) => key !== "off");
	return levels.length === 0 ? "nothing declared" : levels.join(", ");
}

/**
 * One line describing a verdict's derivation — both sides of the difference,
 * because "declared high, endpoint offers low/high/max" is the comparison the
 * caller would otherwise do by hand.
 * @param verdict - one plan verdict.
 * @returns the line.
 */
function lineOf(verdict) {
	const reason = verdict.reason === void 0 ? "" : ` (${REASONS[verdict.reason] ?? verdict.reason})`;
	if (verdict.kind === "update") {
		const dropped = (verdict.removed ?? []).length === 0 ? "" : ` [dropped ${verdict.removed.join(", ")}: the endpoint says reasoning is mandatory]`;
		return `  update ${verdict.id}: declared ${levelsOf(verdict.declared)} → endpoint ${Object.values(verdict.efforts).join(", ")}${dropped}`;
	}
	if (verdict.kind === "clear") return `  clear  ${verdict.id}: declared ${levelsOf(verdict.declared)} → reasoningEfforts: false${reason}`;
	return `  keep   ${verdict.id}${reason}`;
}

/**
 * Render one operation result as the text the model reads.
 *
 * A failure keeps its class and its reason: the point of the taxonomy is that
 * "no credential" and "revision conflict" send the reader to different fixes.
 * @param value - the operation's result.
 * @returns the text.
 */
export function textOf(value) {
	if (value?.ok !== true) return `${TOOL_NAME} failed (${String(value?.kind)}): ${String(value?.message)}`;
	const changed = Array.isArray(value.changes) ? value.changes : [];
	const verdicts = Array.isArray(value.verdicts) ? value.verdicts : [];
	const verb = value.written === true ? "wrote" : "would write";
	const unknown = verdicts.flatMap((verdict) => (verdict.capability?.unknown ?? []).map((level) => `${verdict.id}: ${level}`));
	const head = `${TOOL_NAME} ${String(value.action)} for "${String(value.provider)}" (${verb} ${changed.length} of ${verdicts.length} declared models)`;
	return [
		changed.length === 0 ? `${head} — nothing drifts` : head,
		...verdicts.filter((verdict) => verdict.kind !== "keep").map(lineOf),
		...unknown.length === 0 ? [] : [`  the endpoint publishes levels this adapter does not know (left alone): ${unknown.join("; ")}`]
	].join("\n");
}

/**
 * Build the tool definition.
 *
 * The returned object is what `ctx.tools.register()` takes. It is a raw
 * definition rather than a `defineTool` product because a profile plugin cannot
 * resolve the application's own packages; the shape is the registry's own.
 * @param run - the sync operation, `(input) => Promise<result>`.
 * @returns the registry-ready tool definition.
 */
export function toolDefinition(run) {
	return {
		name: TOOL_NAME,
		description: "Compare one provider route's declared reasoning levels with the levels its endpoint publishes, and optionally write the difference into the profile configuration. Addresses models that are already declared: it never adds, removes, or reorders a model, and it only ever writes the `reasoningEfforts` field. Models the endpoint does not list, or lists without a reasoning capability, are left exactly as they are.",
		parameters: {
			type: "object",
			properties: {
				provider: {
					type: "string",
					description: "Provider route key as it appears under `providers` in the profile configuration, for example \"openrouter-live\"."
				},
				action: {
					type: "string",
					enum: [...ACTIONS],
					description: "\"preview\" reads the endpoint and reports the difference without writing; \"apply\" writes it. Defaults to \"preview\", so writing is always asked for."
				}
			},
			required: ["provider"],
			additionalProperties: false
		},
		output: {
			schema: {
				type: "object",
				properties: {
					ok: {
						type: "boolean",
						description: "Whether the sync ran to completion."
					},
					kind: {
						type: "string",
						description: "Failure class when ok is false: no-route, no-credential, transport, endpoint, catalog, conflict, unwritable, unavailable, or action."
					},
					message: {
						type: "string",
						description: "The reason, phrased for a person."
					},
					provider: {
						type: "string"
					},
					action: {
						type: "string"
					},
					written: {
						type: "boolean",
						description: "Whether the configuration was actually written."
					},
					changes: {
						type: "array",
						items: { type: "string" },
						description: "Ids of the models whose declaration differs from what the endpoint publishes."
					},
					verdicts: {
						type: "array",
						items: { type: "object",
							additionalProperties: true },
						description: "One verdict per declared model, in route order."
					}
				},
				required: ["ok"],
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: textOf(value)
			}]
		},
		async execute(args) {
			return run(args ?? {});
		}
	};
}
