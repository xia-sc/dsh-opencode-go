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
