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
