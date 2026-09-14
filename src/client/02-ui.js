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
			list: { display: "flex", flexDirection: "column", gap: 6, maxHeight: 300, overflowY: "auto", margin: 0, padding: 0, listStyle: "none" },
			item: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, flexWrap: "wrap" },
			modelId: { fontWeight: 500 },
			spacer: { flex: "1 1 auto" },
			summary: { flex: "0 1 auto", fontSize: 11, opacity: 0.6, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			toggle: { flex: "none", font: "inherit", fontSize: 12, padding: "3px 10px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l3, #444)", background: "transparent", color: "var(--dsw-alias-label-primary, #e8eaed)", cursor: "pointer" },
			panel: { flexBasis: "100%", padding: "12px 14px", borderRadius: 10, border: "1px solid var(--dsw-alias-border-l3, #444)", background: "var(--dsw-alias-bg-layer-1, #1e2126)" },
			panelGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "14px 18px" },
			field: { display: "flex", flexDirection: "column", gap: 6, minWidth: 0 },
			fieldLabel: { fontSize: 11, opacity: 0.65 },
			// `boxSizing: border-box` on the full-width controls: without it
			// `width: 100%` means the content box, so padding + border add ~18px
			// and the control overflows its field — swallowing the grid gap and
			// making neighbouring inputs touch (or overlap on a narrow panel).
			mini: { boxSizing: "border-box", width: "100%", minWidth: 0, font: "inherit", fontSize: 12, padding: "3px 8px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l3, #444)", background: "var(--dsw-alias-bg-layer-1, #1e2126)", color: "var(--dsw-alias-label-primary, #e8eaed)" },
			select: { boxSizing: "border-box", width: "100%", minWidth: 0, font: "inherit", fontSize: 12, padding: "3px 6px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l3, #444)", background: "var(--dsw-alias-bg-layer-1, #1e2126)", color: "var(--dsw-alias-label-primary, #e8eaed)" },
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
