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
			heatGrid: { display: "flex", gap: 3 },
			heatCol: { display: "flex", flexDirection: "column", gap: 3 },
			heatCell: { width: 11, height: 11, borderRadius: 2, background: "#161b22" },
			heatDay: { width: 30, height: 11, fontSize: 10, lineHeight: "11px", opacity: 0.6, flex: "none" },
			heatLegend: { display: "flex", alignItems: "center", gap: 3, fontSize: 11, opacity: 0.8 },
			statTable: { width: "100%", fontSize: 12, lineHeight: "20px", borderCollapse: "collapse" },
			statCell: { textAlign: "right", padding: "2px 4px", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" },
			statHead: { textAlign: "right", padding: "2px 4px", opacity: 0.6, fontWeight: 400, whiteSpace: "nowrap" },
			statModel: { textAlign: "left", padding: "2px 4px", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }
		};

		function resultError(res, fallback) {
			if (res && res.ok === true) return null;
			if (res && res.error && res.error.message) return res.error.message;
			return fallback;
		}
