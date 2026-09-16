		/**
		 * Card store: settings snapshot (subscribe), key draft, live catalog.
		 * Host stays authoritative: settings via scope, key via
		 * remote.credentials, catalog via /zen-go-rpc.
		 */
		function createZenGoStore(ctx, scope, credentials) {
			var listeners = new Set();
			var state = { keyDraft: "", busy: null, error: null, notice: null, live: null, known: null, configError: null, liveAt: 0, keyConfigured: null, summary: null, statsLoaded: false, dayDetail: null };
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
					known: state.known,
					configError: state.configError,
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
				loadKnown: function () {
					// The static classification the request path will use, so the
					// card's tags and reasoning presets are right even before (or
					// without) a live catalog refresh. Best effort: a failure just
					// leaves the rows unclassified.
					//
					// The reply also carries the host's settings-section diagnostic:
					// a section the plugin's own validation refuses is dropped whole
					// and the adapter keeps the composition default, so these rows can
					// legitimately disagree with the ids persisted below. Surfacing
					// that here is the only way the user sees why.
					return Promise.resolve()
						.then(function () { return ctx.connection.rpc.call("/zen-go-rpc", "models/known", { args: {} }); })
						.then(function (res) {
							if (res && res.ok === true && res.value && Array.isArray(res.value.models)) {
								set({
									known: res.value.models,
									configError: typeof res.value.configError === "string" && res.value.configError !== "" ? res.value.configError : null
								});
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
					var patch = {};
					patch[field] = value;
					store.setModelCapFields(id, patch);
				},
				/**
				 * Apply several field changes to one model's entry in a SINGLE
				 * settings write. Fields the caller leaves out keep their value; a
				 * null/undefined value deletes the field.
				 *
				 * One write matters because the host validates `surface` and
				 * `efforts` together: committing them apart could persist a pair it
				 * refuses, and a refused section is dropped whole — routing would
				 * then silently fall back to the composition defaults.
				 */
				setModelCapFields: function (id, patch) {
					var snap = snapshot().settings;
					var current = Array.isArray(snap.modelCaps) ? snap.modelCaps.slice() : [];
					var at = -1;
					for (var i = 0; i < current.length; i++) {
						if (current[i] && current[i].id === id) { at = i; break; }
					}
					var entry = at >= 0 ? Object.assign({}, current[at]) : { id: id };
					Object.keys(patch).forEach(function (field) {
						var value = patch[field];
						if (value === null || value === undefined || value === "") delete entry[field];
						else entry[field] = value;
					});
					// An entry exists only while it says something. `false` and `[]`
					// are statements (text-only, no levels), so they keep it alive.
					var blank = entry.contextWindow === undefined && entry.maxTokens === undefined &&
						entry.surface === undefined && entry.image === undefined && entry.efforts === undefined;
					if (at >= 0) {
						if (blank) current.splice(at, 1);
						else current[at] = entry;
					} else if (!blank) {
						current.push(entry);
					}
					try {
						var done = scope.set("modelCaps", current);
						if (done && typeof done.then === "function") done.catch(function () {});
					} catch (e) {
						set({ error: (e && e.message) || String(e) });
					}
				},
				/** Show one transient success line (an edit that also adjusted something else). */
				note: function (text) { set({ notice: text, error: null }); },
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
