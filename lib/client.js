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
			"endpoint.note": "服务端点：{base}（改 endpoint 去设置文件）",
			"error.prefix": "出错："
		};

		var en = {
			"nav": "OpenCode Go",
			"section.title": "OpenCode Go settings",
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
			tag: { fontSize: 11, padding: "0 6px", borderRadius: 4, border: "1px solid var(--dsw-alias-border-l3, #444)", opacity: 0.8 }
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
			var state = { keyDraft: "", busy: null, error: null, notice: null, live: null, liveAt: 0, keyConfigured: null };
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
					keyConfigured: state.keyConfigured
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
				}
			};
			return store;
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
			if (st.error) children.push(h("div", { key: "err", style: S.error }, t("error.prefix") + st.error));
			if (st.notice) children.push(h("div", { key: "ok", style: S.ok }, st.notice));
			return h("div", { style: S.root }, children);
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
