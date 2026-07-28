import ky from "ky";
import { Notice } from "obsidian";
import { normalizeAuthServerUrl } from "./auth-server-url";

interface AuthPlugin {
	settings: {
		authServerUrl: string;
		authProxyKey: string;
		refreshToken: string;
	};
	accessToken: {
		token: string;
		expiresAt: number;
	};
	saveSettings(): Promise<void>;
}

export type ConnectionStatus =
	| "connected"
	| "invalid_configuration"
	| "unreachable";

export type RefreshAccessResult =
	| { ok: true }
	| {
			ok: false;
			reason:
				| "invalid_configuration"
				| "unreachable"
				| "invalid_proxy_key"
				| "invalid_refresh_token"
				| "server_error";
	  };

export const getAuthServerUrl = (plugin: AuthPlugin) =>
	normalizeAuthServerUrl(plugin.settings.authServerUrl);

const clearAccessToken = (plugin: AuthPlugin) => {
	plugin.accessToken = {
		token: "",
		expiresAt: 0,
	};
};

export const checkConnection = async (
	plugin: AuthPlugin
): Promise<ConnectionStatus> => {
	let authServerUrl: string;
	try {
		authServerUrl = getAuthServerUrl(plugin);
	} catch {
		return "invalid_configuration";
	}

	try {
		const result = await ky.get(`${authServerUrl}/api/ping`, {
			timeout: 15_000,
			throwHttpErrors: false,
		});
		return result.ok ? "connected" : "unreachable";
	} catch {
		return "unreachable";
	}
};

export const refreshAccessToken = async (
	plugin: AuthPlugin
): Promise<RefreshAccessResult> => {
	let authServerUrl: string;
	try {
		authServerUrl = getAuthServerUrl(plugin);
	} catch (error) {
		clearAccessToken(plugin);
		new Notice(
			error instanceof Error
				? error.message
				: "The auth server URL is invalid.",
			0
		);
		return { ok: false, reason: "invalid_configuration" };
	}

	if (!plugin.settings.authProxyKey) {
		clearAccessToken(plugin);
		new Notice("Enter the auth proxy key before authenticating.", 0);
		return { ok: false, reason: "invalid_configuration" };
	}
	if (!plugin.settings.refreshToken) {
		clearAccessToken(plugin);
		new Notice("Enter a refresh token before syncing.", 0);
		return { ok: false, reason: "invalid_refresh_token" };
	}

	let response: Response;
	try {
		response = await ky.post(`${authServerUrl}/api/access`, {
			json: { refresh_token: plugin.settings.refreshToken },
			headers: {
				"X-Auth-Proxy-Key": plugin.settings.authProxyKey,
			},
			timeout: 30_000,
			throwHttpErrors: false,
		});
	} catch {
		clearAccessToken(plugin);
		new Notice(
			"The auth server could not be reached. Check its URL, availability, and your network connection.",
			0
		);
		return { ok: false, reason: "unreachable" };
	}

	let body: Record<string, unknown>;
	try {
		body = (await response.json()) as Record<string, unknown>;
	} catch {
		body = {};
	}

	if (response.status === 401 && body.error === "unauthorized") {
		clearAccessToken(plugin);
		new Notice(
			"The auth proxy key was rejected. Check it against AUTH_PROXY_KEY on the server.",
			0
		);
		return { ok: false, reason: "invalid_proxy_key" };
	}

	if (
		!response.ok &&
		(body.error === "invalid_grant" ||
			body.error === "invalid_refresh_token")
	) {
		plugin.settings.refreshToken = "";
		clearAccessToken(plugin);
		await plugin.saveSettings();
		new Notice(
			"The refresh token is invalid or expired. Obtain a new token from this auth server.",
			0
		);
		return { ok: false, reason: "invalid_refresh_token" };
	}

	if (!response.ok) {
		clearAccessToken(plugin);
		new Notice(
			`The auth server could not refresh the access token (HTTP ${response.status}).`,
			0
		);
		return { ok: false, reason: "server_error" };
	}

	if (
		typeof body.access_token !== "string" ||
		typeof body.expires_in !== "number"
	) {
		clearAccessToken(plugin);
		new Notice("The auth server returned an invalid token response.", 0);
		return { ok: false, reason: "server_error" };
	}

	plugin.accessToken = {
		token: body.access_token,
		expiresAt: Date.now() + body.expires_in * 1000,
	};
	return { ok: true };
};
