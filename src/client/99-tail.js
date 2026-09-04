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
