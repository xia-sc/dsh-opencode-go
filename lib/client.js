/**
 * @dsh-plugins/dsh-opencode-go — browser half (dsh.client bundle).
 *
 * Two seats, one shared store:
 *
 *   - `settings.section` → ZenGoSettingsSection: sidebar entry "OpenCode Go"
 *     rendering the full card (key + models + refresh).
 *   - `settings.models.provider-card` → ZenGoProviderCard: rendered on the
 *     Models page under this plugin's own `zen-go` row (slot entryKey is the
 *     settings namespace `llm-opencode-go`). API key field (stored through
 *     `remote.credentials`, never echoed), model checklist persisted to the
 *     plugin settings section (`enabledModels`), and a refresh button that
 *     pulls the live `/v1/models` catalog through the host `/zen-go-rpc`
 *     channel (the browser never sees the key).
 *
 * The bundle is hand-written against the client module table (seed words
 * only: `react`), so it ships without a build step.
 */
window.__ModuleLoader__.load({
	id: "@dsh-plugins/dsh-opencode-go",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");

		var name = "dsh-opencode-go";
		/** Required client services (activation gating for the loader entry). */
		var inject = ["slots", "connection", "locale", "remote", "settingsScope"];

		/** Locale namespace owned by this plugin. */
		var NS = "settings.zengo";
		/** Host settings namespace (slot entryKey + settingsScope binding). */
		var SETTINGS_NS = "llm-opencode-go";
		/** Credential reference when the settings section names none. */
		var DEFAULT_REF = "OPENCODE_GO_API_KEY";
		var zh = {
			"nav": "OpenCode Go",
			"section.title": "OpenCode Go 设置",
			"page.models": "模型设置",
			"page.stats": "统计",
			"key.title": "API 密钥",
			"key.configured": "已配置（存在服务端，不回显）",
			"key.missing": "未配置",
			"key.placeholder": "sk-…",
			"key.save": "保存密钥",
			"key.clear": "清除",
			"key.empty": "请输入密钥",
			"key.saved": "已保存",
			"models.title": "模型",
			"models.refresh": "刷新目录",
			"models.selectAll": "全选",
			"models.selectNone": "全不选",
			"models.ctxPh": "上下文",
			"models.maxPh": "输出上限",
			"models.hint": "点“刷新目录”从服务端拉取可用模型，勾选后才会出现在模型选择器里。",
			"models.surfaces": "三端面（chat / responses / messages）均可用，tag 标注非 chat 模型。",
			"models.enabled": "已选 {count} 个",
			"busy.key": "保存中…",
			"busy.models": "刷新中…",
			"busy.stats": "统计中…",
			"stats.title": "用量统计",
			"stats.tabOverview": "概览",
			"stats.tabModels": "模型",
			"stats.total": "累计",
			"stats.tokens": "tokens",
			"stats.calls": "次调用",
			"stats.colRequests": "请求数",
			"stats.colIO": "输入/输出",
			"stats.colCache": "缓存",
			"stats.colSession": "dsh 会话",
			"stats.colSentId": "x-opencode-session",
			"stats.refresh": "刷新统计",
			"stats.reset": "清空记录",
			"stats.confirm": "确认清空用量记录吗？当前账本会先归档。",
			"stats.empty": "暂无用量记录，先去聊两句。",
			"stats.requests": "请求",
			"stats.sessions": "会话",
			"stats.in": "输入",
			"stats.out": "输出",
			"stats.cache": "缓存命中",
			"stats.model": "模型",
			"stats.less": "少",
			"stats.more": "多",
			"endpoint.note": "服务端点：{base}（改 endpoint 去设置文件）",
			"error.prefix": "出错："
		};

		var en = {
			"nav": "OpenCode Go",
			"section.title": "OpenCode Go settings",
			"page.models": "Model settings",
			"page.stats": "Statistics",
			"key.title": "API key",
			"key.configured": "Configured (server-side, never echoed)",
			"key.missing": "Missing",
			"key.placeholder": "sk-…",
			"key.save": "Save key",
			"key.clear": "Clear",
			"key.empty": "Enter a key",
			"key.saved": "Saved",
			"models.title": "Models",
			"models.refresh": "Refresh catalog",
			"models.selectAll": "Select all",
			"models.selectNone": "Select none",
			"models.ctxPh": "context",
			"models.maxPh": "max out",
			"models.hint": "Refresh pulls the live model list from the server; only checked models appear in the picker.",
			"models.surfaces": "All three surfaces (chat / responses / messages) work; tags mark non-chat models.",
			"models.enabled": "{count} selected",
			"busy.key": "Saving…",
			"busy.models": "Refreshing…",
			"busy.stats": "Loading stats…",
			"stats.title": "Usage",
			"stats.tabOverview": "Overview",
			"stats.tabModels": "Models",
			"stats.total": "Total",
			"stats.tokens": "tokens",
			"stats.calls": "calls",
			"stats.colRequests": "requests",
			"stats.colIO": "in/out",
			"stats.colCache": "cache",
			"stats.colSession": "dsh session",
			"stats.colSentId": "x-opencode-session",
			"stats.refresh": "Refresh stats",
			"stats.reset": "Clear records",
			"stats.confirm": "Clear usage records? The current ledger is archived first.",
			"stats.empty": "No usage yet — go chat first.",
			"stats.requests": "requests",
			"stats.sessions": "sessions",
			"stats.in": "in",
			"stats.out": "out",
			"stats.cache": "cache hit",
			"stats.model": "model",
			"stats.less": "Less",
			"stats.more": "More",
			"endpoint.note": "Endpoint: {base} (change it in the settings file)",
			"error.prefix": "Error: "
		};
		/** React.createElement shorthand. */
		function h(type, props) {
			var children = Array.prototype.slice.call(arguments, 2);
			return React.createElement.apply(React, [type, props].concat(children));
		}

		function fmt(template, params) {
			return String(template).replace(/\{(\w+)\}/g, function (_, key) {
				return params && params[key] !== undefined ? params[key] : "{" + key + "}";
			});
		}

		var S = {
			root: { display: "flex", flexDirection: "column", gap: 12, padding: "4px 2px 2px" },
			row: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
			label: { fontSize: 13, fontWeight: 500 },
			meta: { fontSize: 12, lineHeight: "18px", opacity: 0.72 },
			input: { flex: "1 1 180px", minWidth: 140, font: "inherit", fontSize: 13, padding: "6px 10px", borderRadius: 10, border: "1px solid var(--dsw-alias-border-l3, #444)", background: "var(--dsw-alias-bg-layer-1, #1e2126)", color: "var(--dsw-alias-label-primary, #e8eaed)" },
			button: { font: "inherit", fontSize: 13, padding: "6px 14px", borderRadius: 18, border: ".5px solid var(--dsw-alias-border-l4, #555)", cursor: "pointer", background: "transparent", color: "var(--dsw-alias-label-primary, #e8eaed)" },
			primary: { background: "var(--dsw-alias-button-primary-fill, #1f6feb)", color: "var(--dsw-alias-label-primary-foreground, #fff)", border: "none" },
			error: { color: "var(--dsw-alias-state-error-primary, #ef4444)", fontSize: 12, lineHeight: "18px" },
			ok: { color: "var(--dsw-alias-state-success-primary, #3fb950)", fontSize: 12, lineHeight: "18px" },
			list: { display: "flex", flexDirection: "column", gap: 4, maxHeight: 220, overflowY: "auto", margin: 0, padding: 0, listStyle: "none" },
			item: { display: "flex", alignItems: "center", gap: 8, fontSize: 13 },
			mini: { flex: "none", width: 88, font: "inherit", fontSize: 12, padding: "3px 8px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l3, #444)", background: "var(--dsw-alias-bg-layer-1, #1e2126)", color: "var(--dsw-alias-label-primary, #e8eaed)" },
			tag: { fontSize: 11, padding: "0 6px", borderRadius: 4, border: "1px solid var(--dsw-alias-border-l3, #444)", opacity: 0.8 },
			heatWrap: { display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" },
			heatScroll: { overflowX: "auto", maxWidth: "100%", paddingBottom: 4 },
			heatGrid: { display: "flex", gap: 4 },
			heatCol: { display: "flex", flexDirection: "column", gap: 4 },
			heatCell: { width: 17, height: 17, borderRadius: 3, background: "#161b22", flex: "none" },
			heatDay: { width: 32, height: 17, fontSize: 11, lineHeight: "17px", opacity: 0.6, flex: "none" },
			heatLegend: { display: "flex", alignItems: "center", gap: 4, fontSize: 11, opacity: 0.8 },
			tabs: { display: "flex", gap: 8 },
			tabActive: { fontWeight: 600 },
			statTable: { width: "100%", fontSize: 13, lineHeight: "24px", borderCollapse: "collapse" },
			dayPanel: { display: "flex", flexDirection: "column", gap: 8, padding: 10, borderRadius: 12, border: "1px solid var(--dsw-alias-border-l3, #444)" },
			mono: { textAlign: "left", padding: "2px 4px", fontSize: 11, lineHeight: "16px", opacity: 0.9, whiteSpace: "normal", wordBreak: "break-all" },
			statCell: { textAlign: "right", padding: "2px 4px", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" },
			statHead: { textAlign: "right", padding: "2px 4px", opacity: 0.6, fontWeight: 400, whiteSpace: "nowrap" },
			statModel: { textAlign: "left", padding: "2px 4px", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }
		};

		function resultError(res, fallback) {
			if (res && res.ok === true) return null;
			if (res && res.error && res.error.message) return res.error.message;
			return fallback;
		}
		/**
		 * Card store: settings snapshot (subscribe), key draft, live catalog.
		 * Host stays authoritative: settings via scope, key via
		 * remote.credentials, catalog via /zen-go-rpc.
		 */
		function createZenGoStore(ctx, scope, credentials) {
			var listeners = new Set();
			var state = { keyDraft: "", busy: null, error: null, notice: null, live: null, liveAt: 0, keyConfigured: null, summary: null, statsLoaded: false, dayDetail: null };
			function snapshot() {
				var snap = {};
				try { snap = scope.getSnapshot() || {}; } catch (ignore) { snap = {}; }
				return {
					settings: snap.value || {},
					keyDraft: state.keyDraft,
					busy: state.busy,
					error: state.error,
					notice: state.notice,
					live: state.live,
					liveAt: state.liveAt,
					keyConfigured: state.keyConfigured,
					summary: state.summary,
					statsLoaded: state.statsLoaded,
					dayDetail: state.dayDetail
				};
			}
			function emit() {
				listeners.forEach(function (fn) { try { fn(); } catch (ignore) {} });
			}
			function set(patch) {
				state = Object.assign({}, state, patch);
				emit();
			}
			var disposeScope = null;
			try { disposeScope = scope.subscribe(function () { emit(); }); } catch (ignore) { disposeScope = null; }
			function refOf() {
				var snap = snapshot().settings;
				return typeof snap.apiKeyEnv === "string" && snap.apiKeyEnv !== "" ? snap.apiKeyEnv : DEFAULT_REF;
			}
			var store = {
				snapshot: snapshot,
				subscribe: function (fn) {
					listeners.add(fn);
					return function () { listeners.delete(fn); };
				},
				dispose: function () {
					listeners.clear();
					if (disposeScope) { try { disposeScope(); } catch (ignore) {} }
				},
				setKeyDraft: function (text) { set({ keyDraft: text, error: null, notice: null }); },
				saveKey: function (t) {
					var draft = state.keyDraft.trim();
					if (draft === "") { set({ error: t("key.empty") }); return Promise.resolve(); }
					set({ busy: "key", error: null, notice: null });
					return Promise.resolve()
						.then(function () { return credentials.set(refOf(), draft); })
						.then(function (res) {
							var err = resultError(res, null);
							if (err) set({ busy: null, error: err });
							else set({ busy: null, keyDraft: "", notice: t("key.saved") });
							store.refreshKeyStatus();
						})
						.catch(function (e) { set({ busy: null, error: (e && e.message) || String(e) }); });
				},
				clearKey: function () {
					set({ busy: "key", error: null, notice: null });
					return Promise.resolve()
						.then(function () { return credentials.unset(refOf()); })
						.then(function (res) {
							var err = resultError(res, null);
							set({ busy: null, error: err });
							store.refreshKeyStatus();
						})
						.catch(function (e) { set({ busy: null, error: (e && e.message) || String(e) }); });
				},
				refreshKeyStatus: function () {
					return Promise.resolve()
						.then(function () { return credentials.describe([refOf()]); })
						.then(function (res) {
							if (res && res.ok === true && res.value) {
								var hit = res.value[refOf()];
								if (hit) set({ keyConfigured: hit.configured === true });
							}
						})
						.catch(function () {});
				},
				refresh: function (t) {
					set({ busy: "models", error: null, notice: null });
					return Promise.resolve()
						.then(function () { return ctx.connection.rpc.call("/zen-go-rpc", "models/refresh", { args: {} }); })
						.then(function (res) {
							if (res && res.ok === true && res.value && Array.isArray(res.value.models)) {
								set({ busy: null, live: res.value.models, liveAt: Date.now() });
							} else {
								set({ busy: null, error: resultError(res, t("error.prefix") + "refresh") });
							}
						})
						.catch(function (e) { set({ busy: null, error: (e && e.message) || String(e) }); });
				},
				toggleModel: function (id) {
					var snap = snapshot().settings;
					var current = Array.isArray(snap.enabledModels) ? snap.enabledModels.slice() : [];
					var at = current.indexOf(id);
					if (at >= 0) current.splice(at, 1);
					else current.push(id);
					store.setEnabledModels(current);
				},
				setEnabledModels: function (ids) {
					try {
						var done = scope.set("enabledModels", ids.slice());
						if (done && typeof done.then === "function") done.catch(function () {});
					} catch (e) {
						set({ error: (e && e.message) || String(e) });
					}
				},
				setModelCap: function (id, field, value) {
					var snap = snapshot().settings;
					var current = Array.isArray(snap.modelCaps) ? snap.modelCaps.slice() : [];
					var at = -1;
					for (var i = 0; i < current.length; i++) {
						if (current[i] && current[i].id === id) { at = i; break; }
					}
					var entry = at >= 0 ? Object.assign({}, current[at]) : { id: id };
					if (value === null || value === undefined || value === "") delete entry[field];
					else entry[field] = value;
					if (at >= 0) {
						if (entry.contextWindow === undefined && entry.maxTokens === undefined) current.splice(at, 1);
						else current[at] = entry;
					} else if (entry.contextWindow !== undefined || entry.maxTokens !== undefined) {
						current.push(entry);
					}
					try {
						var done = scope.set("modelCaps", current);
						if (done && typeof done.then === "function") done.catch(function () {});
					} catch (e) {
						set({ error: (e && e.message) || String(e) });
					}
				},
				refreshStats: function (t) {
					set({ busy: "stats", error: null });
					return Promise.resolve()
						.then(function () { return ctx.connection.rpc.call("/zen-go-rpc", "usage/summary", { args: { days: 120 } }); })
						.then(function (res) {
							if (res && res.ok === true && res.value) set({ busy: null, summary: res.value, statsLoaded: true });
							else set({ busy: null, error: resultError(res, t("error.prefix") + "stats") });
						})
						.catch(function (e) { set({ busy: null, error: (e && e.message) || String(e) }); });
				},
				resetStats: function (t) {
					set({ busy: "stats", error: null, notice: null });
					return Promise.resolve()
						.then(function () { return ctx.connection.rpc.call("/zen-go-rpc", "usage/reset", { args: {} }); })
						.then(function (res) {
							var err = resultError(res, null);
							if (err) set({ busy: null, error: err });
							else set({ busy: null });
							return store.refreshStats(t);
						})
						.catch(function (e) { set({ busy: null, error: (e && e.message) || String(e) }); });
				},
				fetchDay: function (t, date) {
					set({ busy: "stats", error: null });
					return Promise.resolve()
						.then(function () { return ctx.connection.rpc.call("/zen-go-rpc", "usage/day", { args: { date: date } }); })
						.then(function (res) {
							if (res && res.ok === true && res.value) set({ busy: null, dayDetail: { date: date, data: res.value } });
							else set({ busy: null, error: resultError(res, t("error.prefix") + "stats") });
						})
						.catch(function (e) { set({ busy: null, error: (e && e.message) || String(e) }); });
				},
				clearDay: function () { set({ dayDetail: null }); }
			};
			return store;
		}
		var HEAT_LEVELS = ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"];
		var HEAT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
		function fmtTokens(n) {
			if (n >= 1000000) return (Math.round(n / 100000) / 10) + "M";
			if (n >= 1000) return (Math.round(n / 100) / 10) + "K";
			return String(n);
		}
		function cacheRate(input, cacheRead) {
			var denom = input + cacheRead;
			if (denom <= 0) return "—";
			return Math.round((cacheRead / denom) * 100) + "%";
		}
		function renderStats(t, store, st, tab, setTab, selectedDate, onSelectDate) {
			var summary = st.summary;
			var tabBtn = function (key, label) {
				var active = tab === key;
				return h("button", {
					key: "tab-" + key,
					type: "button",
					style: active ? Object.assign({}, S.button, S.primary, S.tabActive) : S.button,
					disabled: st.busy !== null,
					onClick: function () { setTab(key); }
				}, label);
			};
			var head = h("div", { key: "shead", style: S.row },
				h("span", { key: "slabel", style: S.label }, t("stats.title")),
				h("button", {
					key: "srefresh",
					type: "button",
					style: S.button,
					disabled: st.busy !== null,
					onClick: function () { store.refreshStats(t); }
				}, st.busy === "stats" ? t("busy.stats") : t("stats.refresh")),
				h("button", {
					key: "sreset",
					type: "button",
					style: S.button,
					disabled: st.busy !== null,
					onClick: function () {
						try {
							if (window.confirm(t("stats.confirm"))) store.resetStats(t);
						} catch (ignore) { store.resetStats(t); }
					}
				}, t("stats.reset"))
			);
			var tabs = h("div", { key: "stabs", style: S.tabs },
				tabBtn("overview", t("stats.tabOverview")),
				tabBtn("models", t("stats.tabModels"))
			);
			if (!summary) return h("div", { key: "stats", style: S.root }, head, tabs, h("div", { key: "sempty", style: S.meta }, t("stats.empty")));
			var totals = summary.totals;
			var grand = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
			var totalsLine = t("stats.total") + " " + fmtTokens(grand) + " " + t("stats.tokens") + " · " +
				t("stats.in") + " " + fmtTokens(totals.input) + " · " +
				t("stats.cache") + " " + fmtTokens(totals.cacheRead) + " · " +
				t("stats.out") + " " + fmtTokens(totals.output) + " · " +
				totals.requests + " " + t("stats.calls") + " · " +
				totals.sessions + " " + t("stats.sessions");
			if (tab === "models") {
				return h("div", { key: "stats", style: S.root }, head, tabs,
					h("div", { key: "stotals", style: S.meta }, totalsLine),
					h("table", { key: "stable", style: S.statTable },
						h("thead", { key: "shead2" }, h("tr", { key: "hr" },
							h("th", { key: "hm", style: Object.assign({}, S.statModel, S.statHead, { textAlign: "left" }) }, t("stats.model")),
							h("th", { key: "hr2", style: S.statHead }, t("stats.colRequests")),
							h("th", { key: "hio", style: S.statHead }, t("stats.colIO")),
							h("th", { key: "hc", style: S.statHead }, t("stats.colCache"))
						)),
						h("tbody", { key: "sbody" }, (summary.byModel || []).map(function (row) {
							return h("tr", { key: row.model },
								h("td", { key: "m", style: S.statModel, title: row.model }, row.model),
								h("td", { key: "r", style: S.statCell }, String(row.requests)),
								h("td", { key: "io", style: S.statCell }, fmtTokens(row.input) + " / " + fmtTokens(row.output)),
								h("td", { key: "c", style: S.statCell }, cacheRate(row.input, row.cacheRead))
							);
						}))
					)
				);
			}
			var days = (summary.days || []).slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
			var max = 0;
			days.forEach(function (d) { max = Math.max(max, d.input); });
			var cells = [];
			if (days.length > 0) {
				var first = new Date(days[0].date + "T00:00:00");
				var lead = isNaN(first.getTime()) ? 0 : (first.getDay() + 6) % 7;
				for (var i = 0; i < lead; i++) cells.push(null);
				days.forEach(function (d) { cells.push(d); });
				while (cells.length % 7 !== 0) cells.push(null);
			}
			var cols = [];
			for (var c = 0; c < cells.length; c += 7) cols.push(cells.slice(c, c + 7));
			var levelOf = function (d) {
				if (!d || max <= 0 || d.input <= 0) return 0;
				return Math.min(4, Math.ceil((d.input / max) * 4));
			};
			var monthOf = function (col) {
				for (var k = 0; k < col.length; k++) {
					if (col[k]) return col[k].date.slice(0, 7);
				}
				return null;
			};
			var lastMonth = null;
			var grid = h("div", { key: "heat", style: S.heatWrap },
				h("div", { key: "daynames", style: S.heatCol },
					["Mon", "", "Wed", "", "Fri", "", ""].map(function (name, idx) {
						return h("div", { key: "dn" + idx, style: S.heatDay }, name);
					})
				),
				cols.map(function (col, ci) {
					var month = monthOf(col);
					var label = month !== null && month !== lastMonth ? HEAT_MONTHS[Number(month.slice(5, 7)) - 1] : "";
					lastMonth = month !== null ? month : lastMonth;
					return h("div", { key: "col" + ci, style: S.heatCol },
						h("div", { key: "mlabel", style: S.heatDay }, label),
						col.map(function (d, ri) {
							var selected = d !== null && d.date === selectedDate;
							return h("div", {
								key: "c" + ci + "-" + ri,
								style: Object.assign({}, S.heatCell, { background: HEAT_LEVELS[levelOf(d)] },
									d ? { cursor: "pointer" } : null,
									selected ? { outline: "2px solid var(--dsw-alias-label-primary, #e8eaed)", outlineOffset: 1 } : null),
								title: d ? d.date + ": " + fmtTokens(d.input) + " in / " + fmtTokens(d.output) + " out" : "",
								onClick: d ? function () { onSelectDate(d.date); } : undefined
							});
						})
					);
				}),
				h("div", { key: "legend", style: S.heatLegend },
					h("span", { key: "ll" }, t("stats.less")),
					HEAT_LEVELS.map(function (color, li) {
						return h("div", { key: "l" + li, style: Object.assign({}, S.heatCell, { background: color }) });
					}),
					h("span", { key: "lm" }, t("stats.more"))
				)
			);
			var detail = null;
			if (st.dayDetail && st.dayDetail.date) {
				var dd = st.dayDetail.data || {};
				var dt = dd.totals || { requests: 0, input: 0, output: 0, cacheRead: 0 };
				detail = h("div", { key: "daydetail", style: S.dayPanel },
					h("div", { key: "ddhead", style: S.row },
						h("span", { key: "ddate", style: S.label }, st.dayDetail.date),
						h("span", { key: "dtotal", style: S.meta },
							dt.requests + " " + t("stats.calls") + " · " +
							t("stats.in") + " " + fmtTokens(dt.input) + " · " +
							t("stats.cache") + " " + fmtTokens(dt.cacheRead) + " · " +
							t("stats.out") + " " + fmtTokens(dt.output)),
						h("button", {
							key: "dclose",
							type: "button",
							style: S.button,
							onClick: function () { onSelectDate(null); }
						}, "×")
					),
					h("table", { key: "dtable", style: S.statTable },
						h("thead", { key: "dhead" }, h("tr", { key: "dhr" },
							h("th", { key: "ds", style: Object.assign({}, S.statModel, S.statHead, { textAlign: "left" }) }, t("stats.colSession")),
							h("th", { key: "dh", style: Object.assign({}, S.statModel, S.statHead, { textAlign: "left" }) }, t("stats.colSentId")),
							h("th", { key: "dr", style: S.statHead }, t("stats.colRequests")),
							h("th", { key: "dio", style: S.statHead }, t("stats.colIO")),
							h("th", { key: "dc", style: S.statHead }, t("stats.colCache"))
						)),
						h("tbody", { key: "dbody" }, ((dd.sessions || []).map(function (row, idx) {
							return h("tr", { key: "ds" + idx },
								h("td", { key: "s", style: S.mono, title: row.session || "" }, row.session || "—"),
								h("td", { key: "h", style: S.mono, title: row.sessionHeader || "" }, row.sessionHeader || "—"),
								h("td", { key: "r", style: S.statCell }, String(row.requests)),
								h("td", { key: "io", style: S.statCell }, fmtTokens(row.input) + " / " + fmtTokens(row.output)),
								h("td", { key: "c", style: S.statCell }, cacheRate(row.input, row.cacheRead))
							);
						})))
					)
				);
			}
			return h("div", { key: "stats", style: S.root },
				head,
				tabs,
				h("div", { key: "stotals", style: S.meta }, totalsLine),
				h("div", { key: "heatscroll", style: S.heatScroll }, grid),
				detail
			);
		}

		function ZenGoProviderCard(props) {
			var store = props.store;
			var t = props.t || function (key, params) { return fmt(key, params); };
			var pair = React.useState(function () { return store.snapshot(); });
			var st = pair[0];
			var setSt = pair[1];
			React.useEffect(function () {
				return store.subscribe(function () { setSt(store.snapshot()); });
			}, [store]);
			React.useEffect(function () { store.refreshStats(t); }, [store]);
			var tabPair = React.useState("overview");
			var statsTab = tabPair[0];
			var setStatsTab = tabPair[1];
			var pagePair = React.useState("settings");
			var pageTab = pagePair[0];
			var setPageTab = pagePair[1];
			var dayPair = React.useState(null);
			var selectedDate = dayPair[0];
			var setSelectedDate = dayPair[1];
			var onSelectDate = function (date) {
				if (date === null || date === selectedDate) {
					setSelectedDate(null);
					store.clearDay();
				} else {
					setSelectedDate(date);
					store.fetchDay(t, date);
				}
			};
			var keyConfigured = st.keyConfigured === true || (st.keyConfigured === null && props.keyConfigured === true);
			var settings = st.settings || {};
			var enabled = Array.isArray(settings.enabledModels) ? settings.enabledModels : null;
			var live = st.live;
			var rows;
			if (live) {
				rows = live;
			} else if (enabled) {
				rows = enabled.map(function (id) { return { id: id, surface: "chat" }; });
			} else {
				rows = [];
			}
			var enabledCount = enabled ? enabled.length : 0;
			var caps = {};
			(Array.isArray(settings.modelCaps) ? settings.modelCaps : []).forEach(function (entry) {
				if (entry && typeof entry.id === "string") caps[entry.id] = entry;
			});
			var commitCap = function (id, field, text, reset) {
				var n = Math.floor(Number(String(text).trim()));
				if (text.trim() !== "" && Number.isFinite(n) && n >= 1) store.setModelCap(id, field, n);
				else if (text.trim() === "") store.setModelCap(id, field, null);
				else reset();
			};

			var children = [];
			children.push(h("div", { key: "keyrow", style: S.row },
				h("span", { key: "klabel", style: S.label }, t("key.title")),
				h("span", { key: "kstatus", style: S.meta }, keyConfigured ? t("key.configured") : t("key.missing")),
				h("input", {
					key: "kinput",
					type: "password",
					style: S.input,
					placeholder: t("key.placeholder"),
					value: st.keyDraft,
					disabled: st.busy !== null,
					onChange: function (e) { store.setKeyDraft(e.target.value); }
				}),
				h("button", {
					key: "ksave",
					type: "button",
					style: Object.assign({}, S.button, S.primary),
					disabled: st.busy !== null,
					onClick: function () { store.saveKey(t); }
				}, st.busy === "key" ? t("busy.key") : t("key.save")),
				h("button", {
					key: "kclear",
					type: "button",
					style: S.button,
					disabled: st.busy !== null,
					onClick: function () { store.clearKey(); }
				}, t("key.clear"))
			));
			children.push(h("div", { key: "modelshead", style: S.row },
				h("span", { key: "mlabel", style: S.label }, t("models.title")),
				h("span", { key: "mcount", style: S.meta }, t("models.enabled", { count: enabledCount })),
				h("button", {
					key: "mrefresh",
					type: "button",
					style: S.button,
					disabled: st.busy !== null,
					onClick: function () { store.refresh(t); }
				}, st.busy === "models" ? t("busy.models") : t("models.refresh")),
				rows.length === 0 ? null : h("button", {
					key: "mselect",
					type: "button",
					style: S.button,
					disabled: st.busy !== null,
					onClick: function () {
						var allOn = rows.every(function (row) { return enabled && enabled.indexOf(row.id) >= 0; });
						store.setEnabledModels(allOn ? [] : rows.map(function (row) { return row.id; }));
					}
				}, rows.every(function (row) { return enabled && enabled.indexOf(row.id) >= 0; }) ? t("models.selectNone") : t("models.selectAll"))
			));
			if (rows.length === 0) {
				children.push(h("div", { key: "mhint", style: S.meta }, t("models.hint")));
			} else {
				children.push(h("ul", { key: "mlist", style: S.list }, rows.map(function (row) {
					var isOn = enabled ? enabled.indexOf(row.id) >= 0 : false;
					var cap = caps[row.id] || {};
					var capKey = function (field) { return "cap-" + row.id + "-" + field + ":" + (cap[field] === undefined ? "" : cap[field]); };
					var capInput = function (field, placeholder) {
						return h("input", {
							key: capKey(field),
							type: "input",
							inputMode: "numeric",
							style: S.mini,
							placeholder: placeholder,
							defaultValue: cap[field] === undefined ? "" : String(cap[field]),
							disabled: st.busy !== null,
							title: placeholder,
							onBlur: function (e) { commitCap(row.id, field, e.target.value, function () { e.target.value = cap[field] === undefined ? "" : String(cap[field]); }); },
							onKeyDown: function (e) { if (e.key === "Enter") e.target.blur(); }
						});
					};
					return h("li", { key: row.id, style: S.item },
						h("input", {
							type: "checkbox",
							checked: isOn,
							disabled: st.busy !== null,
							title: row.id,
							onChange: function () { store.toggleModel(row.id); }
						}),
						h("span", { key: "id" }, row.id),
						row.surface && row.surface !== "chat"
							? h("span", { key: "surface", style: S.tag }, row.surface)
							: null,
						(Array.isArray(row.input) ? row.input : []).map(function (mod) {
							return h("span", { key: "mod-" + mod, style: S.tag }, mod);
						}),
						capInput("contextWindow", t("models.ctxPh")),
						capInput("maxTokens", t("models.maxPh"))
					);
				})));
				children.push(h("div", { key: "mnote", style: S.meta }, t("models.surfaces")));
			}
			if (settings.apiBase) {
				children.push(h("div", { key: "endpoint", style: S.meta }, t("endpoint.note", { base: settings.apiBase })));
			}
			var pageBtn = function (key, label) {
				var active = pageTab === key;
				return h("button", {
					key: "pt-" + key,
					type: "button",
					style: active ? Object.assign({}, S.button, S.primary, S.tabActive) : S.button,
					disabled: st.busy !== null,
					onClick: function () { setPageTab(key); }
				}, label);
			};
			var pageTabs = h("div", { key: "pagetabs", style: S.tabs },
				pageBtn("settings", t("page.models")),
				pageBtn("stats", t("page.stats"))
			);
			var tail = [];
			if (st.error) tail.push(h("div", { key: "err", style: S.error }, t("error.prefix") + st.error));
			if (st.notice) tail.push(h("div", { key: "ok", style: S.ok }, st.notice));
			var body = pageTab === "stats" ? [renderStats(t, store, st, statsTab, setStatsTab, selectedDate, onSelectDate)] : children;
			return h("div", { style: S.root }, [pageTabs].concat(body).concat(tail));
		}
		function ZenGoSettingsSection(props) {
			var store = props.store;
			var t = props.t || function (key, params) { return fmt(key, params); };
			var pair = React.useState(function () { return store.snapshot(); });
			var st = pair[0];
			var setSt = pair[1];
			React.useEffect(function () {
				return store.subscribe(function () { setSt(store.snapshot()); });
			}, [store]);
			React.useEffect(function () { store.refreshKeyStatus(); }, [store]);
			return h("div", { style: { maxWidth: 720, display: "flex", flexDirection: "column", gap: 12 } },
				h("h2", { key: "title", style: { margin: 0, fontSize: 16, fontWeight: 500, lineHeight: "24px" } }, t("section.title")),
				h(ZenGoProviderCard, { key: "card", store: store, t: t, keyConfigured: st.keyConfigured === true })
			);
		}
		function apply(ctx) {
			ctx.effect(function () {
				return ctx.locale.register(NS, { zh: zh, en: en });
			}, "dsh-opencode-go: dictionaries");
			var scope = ctx.settingsScope.bind({ namespace: SETTINGS_NS });
			ctx.inject(["remote.credentials"], function (remoteCtx) {
				var credentials = remoteCtx.remote.credentials;
				var store = createZenGoStore(ctx, scope, credentials);
				ctx.effect(function () {
					return function () { store.dispose(); };
				}, "dsh-opencode-go: settings store");
				ctx.slots.inject("settings.section", function () {
					return ctx.slots.register({
						name: "settings.section",
						id: "zengo",
						order: 13,
						label: function () { return remoteCtx.locale.bind(NS)("nav"); },
						locale: NS,
						inject: function () { return { store: store }; }
					}, ZenGoSettingsSection);
				});
				ctx.slots.inject("settings.models.provider-card", function () {
					return ctx.slots.register({
						name: "settings.models.provider-card",
						key: "llm-opencode-go",
						locale: NS,
						inject: function () { return { store: store }; }
					}, ZenGoProviderCard);
				});
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
