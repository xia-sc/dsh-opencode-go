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
		function renderStats(t, store, st) {
			var summary = st.summary;
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
			if (!summary) return h("div", { key: "stats", style: S.root }, head, h("div", { key: "sempty", style: S.meta }, t("stats.empty")));
			var totals = summary.totals;
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
							return h("div", {
								key: "c" + ci + "-" + ri,
								style: Object.assign({}, S.heatCell, { background: HEAT_LEVELS[levelOf(d)] }),
								title: d ? d.date + ": " + fmtTokens(d.input) + " in / " + fmtTokens(d.output) + " out" : ""
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
			var table = h("table", { key: "stable", style: S.statTable },
				h("tbody", { key: "sbody" }, (summary.byModel || []).map(function (row) {
					return h("tr", { key: row.model },
						h("td", { key: "m", style: S.statModel, title: row.model }, row.model),
						h("td", { key: "r", style: S.statCell }, String(row.requests)),
						h("td", { key: "io", style: S.statCell }, fmtTokens(row.input) + " / " + fmtTokens(row.output)),
						h("td", { key: "c", style: S.statCell }, cacheRate(row.input, row.cacheRead))
					);
				}))
			);
			var totalsLine = totals.requests + " " + t("stats.requests") + " · " +
				totals.sessions + " " + t("stats.sessions") + " · " +
				t("stats.in") + " " + fmtTokens(totals.input) + " · " +
				t("stats.out") + " " + fmtTokens(totals.output) + " · " +
				t("stats.cache") + " " + cacheRate(totals.input, totals.cacheRead);
			return h("div", { key: "stats", style: S.root },
				head,
				h("div", { key: "stotals", style: S.meta }, totalsLine),
				grid,
				table
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
			children.push(renderStats(t, store, st));
			if (st.error) children.push(h("div", { key: "err", style: S.error }, t("error.prefix") + st.error));
			if (st.notice) children.push(h("div", { key: "ok", style: S.ok }, st.notice));
			return h("div", { style: S.root }, children);
		}
