/**
 * Client half of `dsh-reasoning-sync`: the card the Models settings page shows
 * inside a served provider's row.
 *
 * The seat is the one the page reserves for plugins outside the application --
 * `settings.models.provider-card`, a `keyed` child slot dispatched by the
 * settings namespace. The page hands every entry a `{ provider, configured,
 * keyConfigured }` share and keys the cell by `row.entry.settingsNs`, which is
 * the adapter entry's own id; the id is therefore asked of the Host rather than
 * assumed, and the same answer says **which routes this plugin serves**, since
 * the page's provider share carries no `baseURL` to decide that from.
 *
 * What the card shows and does:
 *
 * - on mount it previews: the levels the endpoint publishes against the levels
 *   currently declared, per model (`preview` writes nothing);
 * - one action writes the difference (`apply`), then re-previews, so the card
 *   says "up to date" from the Host's own answer rather than from optimism;
 * - a failure is shown with its class and reason, and nothing was written.
 *
 * Both actions are the Host's operation — the same one the agent tool runs — so
 * this half owns no sync logic, only the reading of it. It imports nothing but
 * `react` from the platform seed table, styles with `--dsw-alias-*` tokens, and
 * routes its text through the Client locale service.
 */

window.__ModuleLoader__.load({
	id: "dsh-reasoning-sync",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		/** The reserved keyed seat this plugin registers into. */
		const SLOT = "settings.models.provider-card";
		/** Locale namespace holding this card's text. */
		const LOCALE_NAMESPACE = "reasoning-sync";
		/** Host route running one sync. */
		const SYNC_ROUTE = "/api/reasoning-sync.sync";
		/** Host route answering which provider routes this plugin serves. */
		const ROUTES_ROUTE = "/api/reasoning-sync.routes";
		/** Registration order inside the seat; the page's own content comes first. */
		const ORDER = 20;
		/**
		 * How long the seat discovery may take.
		 *
		 * It runs inside `apply`, so an endpoint that never answers would hold the
		 * plugin's activation open; failing after a few seconds instead leaves the
		 * page exactly as it was.
		 */
		const ROUTES_TIMEOUT_MS = 5_000;

		const DICTIONARY = {
			zh: {
				checking: "正在读取端点公布的等级…",
				working: "正在写进配置…",
				failed: "同步失败",
				drift: "{count} 个模型的等级与端点公布的不一致",
				current: "已是最新：与端点公布的等级一致",
				applied: "已写入 {count} 个模型",
				recheck: "重新检查",
				sync: "同步到配置",
				update: "{id}：当前 {declared} → 端点 {published}",
				updateDefault: "{id}：当前 {declared} → 端点 {published} · 默认 {effort}",
				clear: "{id}：当前 {declared} → 端点未公布可声明等级，写 reasoningEfforts: false",
				inSync: "{id}：已是最新 · {declared}",
				unknown: "{id}：端点未公布推理能力，保持原样",
				unmappable: "{id}：端点公布的档位本适配器不认识，保持原样",
				cloaked: "{id}：端点目录里没有，保持原样",
				dropped: "{id}：端点说推理不可关闭，已存在的 off 声明被移除",
				adapterUnknown: "本适配器不认识的档位（未做任何改动）：{levels}",
				nonReasoning: "非推理",
				nothingDeclared: "未声明",
				defaultOff: "关掉推理",
				hint: "只写 reasoningEfforts 一个字段，不新增、不删除模型"
			},
			en: {
				checking: "Reading the levels the endpoint publishes…",
				working: "Writing the configuration…",
				failed: "Sync failed",
				drift: "{count} models differ from what the endpoint publishes",
				current: "Up to date with the levels the endpoint publishes",
				applied: "Wrote {count} models",
				recheck: "Check again",
				sync: "Sync into configuration",
				update: "{id}: declared {declared} → endpoint {published}",
				updateDefault: "{id}: declared {declared} → endpoint {published} · default {effort}",
				clear: "{id}: declared {declared} → the endpoint publishes no declarable level; writes reasoningEfforts: false",
				inSync: "{id}: up to date · {declared}",
				unknown: "{id}: the endpoint publishes no reasoning capability; left alone",
				unmappable: "{id}: the endpoint publishes levels this adapter does not know; left alone",
				cloaked: "{id}: not in the endpoint catalog; left alone",
				dropped: "{id}: the endpoint says reasoning cannot be disabled, so an existing off declaration is removed",
				adapterUnknown: "Levels this adapter does not know (nothing was changed): {levels}",
				nonReasoning: "non-reasoning",
				nothingDeclared: "nothing declared",
				defaultOff: "reasoning off",
				hint: "Writes the reasoningEfforts field alone — never adds or removes a model"
			}
		};

		/** Panel frame: the host's card surface and stroke. */
		const PANEL = {
			marginTop: "8px",
			padding: "10px 12px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: "8px",
			background: "var(--dsw-alias-bg-layer-2)",
			display: "flex",
			flexDirection: "column",
			gap: "6px"
		};
		/** One line of text. */
		const LINE = {
			fontSize: "13px",
			lineHeight: "18px",
			color: "var(--dsw-alias-label-primary)"
		};
		/** A model row: secondary text, so the headline keeps the weight. */
		const ROW = {
			...LINE,
			fontSize: "12px",
			color: "var(--dsw-alias-label-secondary)",
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
		};
		/** A failure, and anything else the reader must not miss. */
		const ALERT = {
			...LINE,
			color: "var(--dsw-alias-state-error-primary)"
		};
		/** The action, when there is something to write. */
		const PRIMARY = {
			alignSelf: "flex-start",
			padding: "4px 10px",
			border: "none",
			borderRadius: "6px",
			fontSize: "12px",
			cursor: "pointer",
			background: "var(--dsw-alias-button-primary-fill)",
			color: "var(--dsw-alias-label-primary-foreground)"
		};
		/** The action, when it only re-reads. */
		const SECONDARY = {
			...PRIMARY,
			background: "transparent",
			color: "var(--dsw-alias-label-secondary)",
			border: "1px solid var(--dsw-alias-border-l2)"
		};
		/**
		 * A footnote: what a sync will not touch, a key it dropped, a level this
		 * adapter does not know. Tertiary rather than dimmed — `label-dimmed` is
		 * the disabled-state token and reads as nearly invisible on the dark
		 * theme's card surface.
		 */
		const HINT = {
			...LINE,
			fontSize: "12px",
			color: "var(--dsw-alias-label-tertiary)"
		};

		/**
		 * Read one JSON answer from this Host.
		 * @param path - the route to call.
		 * @param init - fetch options.
		 * @returns the parsed body, or a failure result shaped like the operation's.
		 */
		async function ask(path, init) {
			const response = await fetch(path, init);
			if (response.ok !== true) return {
				ok: false,
				kind: "request",
				message: `${path} answered ${response.status}`
			};
			return response.json();
		}

		/**
		 * A JSON POST to one Host route.
		 * @param body - the request body.
		 * @returns fetch options.
		 */
		function post(body) {
			return {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			};
		}

		/**
		 * Read one side of a comparison as the levels it names.
		 *
		 * `off` is deliberately not counted: it is not a level, it is the key that
		 * decides what an unselected level dispatches.
		 * @param declared - a verdict's declaration side.
		 * @returns the levels it declares.
		 */
		function declaredLevels(declared) {
			if (declared === false) return false;
			if (declared === null || typeof declared !== "object") return [];
			return Object.keys(declared).filter((key) => key !== "off");
		}

		/**
		 * Turn one result into everything the card renders.
		 *
		 * Kept pure and separate from the component so the rules — which side of
		 * the comparison a row carries, what a model with nothing to do says — are
		 * asserted without a renderer. The levels travel as data and the wording is
		 * applied at render time, so one summary serves both languages.
		 *
		 * **Every** declared model earns a row, including the ones already in step.
		 * A card that lists only what drifts cannot be told apart from a card that
		 * only checked what drifts: "up to date" has to be said per model, not just
		 * in the headline.
		 * @param result - the operation's result, as the Host returned it.
		 * @returns the view model: a tone, one row per declared model, the
		 * adapter-unknown levels, and the dropped keys.
		 */
		function summaryOf(result) {
			if (result === null || result === void 0 || result.ok !== true) return {
				tone: "error",
				message: typeof result?.message === "string" ? result.message : String(result?.message ?? result),
				rows: [],
				adapterUnknown: [],
				dropped: []
			};
			const verdicts = Array.isArray(result.verdicts) ? result.verdicts : [];
			const rows = [];
			const dropped = [];
			for (const verdict of verdicts) {
				if ((verdict.removed ?? []).length > 0) dropped.push({ id: verdict.id });
				if (verdict.kind === "update") rows.push({
					id: verdict.id,
					key: verdict.capability?.defaultEffort === void 0 ? "update" : "updateDefault",
					declared: declaredLevels(verdict.declared),
					published: Object.values(verdict.efforts ?? {}),
					effort: verdict.capability?.defaultEffort
				});
				else if (verdict.kind === "clear") rows.push({
					id: verdict.id,
					key: "clear",
					declared: declaredLevels(verdict.declared)
				});
				else if (verdict.reason === "in-sync") rows.push({
					id: verdict.id,
					key: "inSync",
					declared: declaredLevels(verdict.declared)
				});
				else rows.push({
					id: verdict.id,
					key: verdict.reason === "cloaked" ? "cloaked" : verdict.reason === "unmappable" ? "unmappable" : "unknown"
				});
			}
			const adapterUnknown = verdicts.flatMap((verdict) => {
				const levels = verdict.capability?.unknown ?? [];
				return levels.length === 0 ? [] : [{
					id: verdict.id,
					levels: levels.join(" · ")
				}];
			});
			const changes = Array.isArray(result.changes) ? result.changes.length : 0;
			return {
				tone: changes === 0 ? "current" : "drift",
				changes,
				rows,
				adapterUnknown,
				dropped
			};
		}

		/**
		 * Name one side of the comparison in the reader's language.
		 * @param t - the bound translator.
		 * @param levels - the levels that side names, or `false` for the non-reasoning form.
		 * @returns the text.
		 */
		function levelsText(t, levels) {
			if (levels === false) return t("nonReasoning");
			return Array.isArray(levels) && levels.length > 0 ? levels.join(" · ") : t("nothingDeclared");
		}

		/**
		 * Name the level an unselected effort lands on.
		 *
		 * `default_effort` is a pointer, and the endpoint may point it at `none` —
		 * "with no instruction, reasoning is off". `none` is not a level, so it is
		 * spelled out rather than printed, or the card would read as though it were
		 * a level the user could declare.
		 * @param t - the bound translator.
		 * @param effort - the endpoint's `default_effort`.
		 * @returns the text.
		 */
		function effortText(t, effort) {
			return effort === "none" ? t("defaultOff") : effort;
		}

		/**
		 * A human reason for a thrown request failure.
		 * @param error - whatever the fetch rejected with.
		 * @returns the message.
		 */
		function messageOf(error) {
			return String(error?.message ?? error);
		}

		/**
		 * The one line at the top of the card.
		 *
		 * A failure is answered by the Host as a result rather than as a thrown
		 * error, so the summary — not the phase — decides whether the card is
		 * reporting a refusal or a state: a refused sync must not read as "up to
		 * date" just because the request itself arrived.
		 * @param t - the bound translator.
		 * @param view - the card's state.
		 * @param summary - the summary, once there is a result to summarize.
		 * @returns the headline text.
		 */
		function headline(t, view, summary) {
			if (view.phase === "loading") return t("checking");
			if (view.phase === "working") return view.applying === true ? t("working") : t("checking");
			if (view.phase === "failed") return `${t("failed")}: ${view.message}`;
			if (summary?.tone === "error") return `${t("failed")}: ${summary.message}`;
			return summary?.tone === "drift" ? t("drift", { count: summary.changes }) : t("current");
		}

		/**
		 * The card.
		 *
		 * `t` arrives through the registration's `locale` option, so a language
		 * switch re-renders this component through the framework's own seat.
		 * @param props - the seat's provider share plus the bound `t`.
		 * @returns the rendered card.
		 */
		function Card(props) {
			const t = props.t;
			const route = props.provider?.provider;
			const [view, setView] = React.useState({ phase: "loading" });

			React.useEffect(() => {
				let live = true;
				ask(SYNC_ROUTE, post({
					provider: route,
					action: "preview"
				})).then((result) => {
					if (live) setView({
						phase: "ready",
						result
					});
				}, (error) => {
					if (live) setView({
						phase: "failed",
						message: messageOf(error)
					});
				});
				return () => {
					live = false;
				};
			}, [route]);

			const summary = view.result === void 0 ? void 0 : summaryOf(view.result);
			const drifting = summary?.tone === "drift";

			/**
			 * Run the action the current state calls for: write the difference when
			 * there is one, re-read when there is not. After a write the card
			 * previews again, so "up to date" is the Host's answer, not optimism.
			 */
			const act = async () => {
				setView({
					phase: "working",
					result: view.result,
					applying: drifting
				});
				try {
					const answer = await ask(SYNC_ROUTE, post({
						provider: route,
						action: drifting ? "apply" : "preview"
					}));
					if (!drifting || answer.ok !== true) {
						setView({
							phase: "ready",
							result: answer
						});
						return;
					}
					const after = await ask(SYNC_ROUTE, post({
						provider: route,
						action: "preview"
					}));
					setView({
						phase: "ready",
						result: after,
						applied: Array.isArray(answer.changes) ? answer.changes.length : 0
					});
				} catch (error) {
					setView({
						phase: "failed",
						message: messageOf(error)
					});
				}
			};

			const children = [React.createElement("div", {
				key: "headline",
				style: summary?.tone === "error" ? ALERT : LINE
			}, headline(t, view, summary))];

			if (view.applied !== void 0) children.push(React.createElement("div", {
				key: "applied",
				style: ROW
			}, t("applied", { count: view.applied })));
			for (const row of summary?.rows ?? []) children.push(React.createElement("div", {
				key: `row:${row.id}`,
				style: ROW
			}, t(row.key, {
				id: row.id,
				declared: levelsText(t, row.declared),
				published: row.published?.join(" · "),
				effort: effortText(t, row.effort)
			})));
			for (const drop of summary?.dropped ?? []) children.push(React.createElement("div", {
				key: `dropped:${drop.id}`,
				style: HINT
			}, t("dropped", { id: drop.id })));
			for (const unknown of summary?.adapterUnknown ?? []) children.push(React.createElement("div", {
				key: `unknown:${unknown.id}`,
				style: HINT
			}, t("adapterUnknown", { levels: `${unknown.id}: ${unknown.levels}` })));

			if (view.phase === "loading") return React.createElement("div", { style: PANEL }, children);
			children.push(React.createElement("div", {
				key: "hint",
				style: HINT
			}, t("hint")));
			children.push(React.createElement("button", {
				key: "action",
				type: "button",
				style: drifting ? PRIMARY : SECONDARY,
				disabled: view.phase === "working",
				onClick: () => {
					void act();
				}
			}, drifting ? t("sync") : t("recheck")));
			return React.createElement("div", { style: PANEL }, children);
		}

		/** Required services: the slot registry and the locale service. */
		const inject = ["slots", "locale"];

		/**
		 * Client plugin body: claim the seat for each namespace that holds a
		 * served route.
		 *
		 * The Host answers which routes those are, because the seat's props carry
		 * the route id but not the endpoint it points at. A Host that cannot answer
		 * leaves the page untouched -- no seat, no card, no half-rendered row.
		 * @param ctx - client root context.
		 */
		async function apply(ctx) {
			ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, DICTIONARY), "reasoning-sync: card copy");
			let listed;
			try {
				listed = await ask(ROUTES_ROUTE, typeof globalThis.AbortSignal?.timeout === "function" ? { signal: globalThis.AbortSignal.timeout(ROUTES_TIMEOUT_MS) } : void 0);
			} catch (error) {
				console.warn(`reasoning-sync: cannot ask this Host which routes it serves: ${messageOf(error)}`);
				return;
			}
			if (!Array.isArray(listed?.routes) || !Array.isArray(listed?.namespaces)) {
				console.warn(`reasoning-sync: this Host did not answer which routes it serves${typeof listed?.message === "string" ? `: ${listed.message}` : ""}`);
				return;
			}
			const served = new Set(listed.routes.map((route) => route.provider));
			for (const namespace of listed.namespaces) ctx.slots.inject(SLOT, () => ctx.slots.register({
				name: SLOT,
				key: namespace,
				id: "reasoning-sync",
				order: ORDER,
				locale: LOCALE_NAMESPACE
			}, (props) => served.has(props.provider?.provider) ? React.createElement(Card, props) : null));
		}

		/** Exposed for the deterministic suite; the bundle itself only needs `apply`. */
		exports.SLOT = SLOT;
		exports.LOCALE_NAMESPACE = LOCALE_NAMESPACE;
		exports.SYNC_ROUTE = SYNC_ROUTE;
		exports.ROUTES_ROUTE = ROUTES_ROUTE;
		exports.ORDER = ORDER;
		exports.summaryOf = summaryOf;
		exports.Card = Card;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
