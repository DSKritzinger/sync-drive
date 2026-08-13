import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
	configFromEnv,
	createServer,
	validateConfig,
} from "../server.js";

const openServers = new Set();

afterEach(async () => {
	await Promise.all(
		[...openServers].map(
			(server) =>
				new Promise((resolve, reject) =>
					server.close((error) =>
						error ? reject(error) : resolve()
					)
				)
		)
	);
	openServers.clear();
});

const testConfig = (overrides = {}) =>
	validateConfig({
		clientId: "test-client-id.apps.googleusercontent.com",
		clientSecret: "test-client-secret",
		publicBaseUrl: "https://auth.example.test",
		authProxyKey: "test-proxy-key",
		allowedOrigins: ["app://obsidian.md"],
		secureCookies: true,
		port: 0,
		...overrides,
	});

const startServer = async ({
	fetchImpl = async () => {
		throw new Error("Unexpected Google request");
	},
	stateGenerator = () => "fixed-oauth-state",
	config = testConfig(),
} = {}) => {
	const server = createServer(config, {
		fetchImpl,
		stateGenerator,
		logger: { error() {} },
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	openServers.add(server);
	const address = server.address();
	assert(address && typeof address === "object");
	return `http://127.0.0.1:${address.port}`;
};

const jsonResponse = (body, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

test("configuration reads secrets from files", () => {
	const temporaryDirectory = fs.mkdtempSync(
		path.join(os.tmpdir(), "sync-drive-auth-")
	);

	try {
		const clientSecretFile = path.join(
			temporaryDirectory,
			"google_client_secret"
		);
		const proxyKeyFile = path.join(
			temporaryDirectory,
			"auth_proxy_key"
		);

		fs.writeFileSync(clientSecretFile, "google-secret\n");
		fs.writeFileSync(proxyKeyFile, "proxy-secret\r\n");

		const config = configFromEnv({
			GOOGLE_CLIENT_ID: "test-client-id",
			GOOGLE_CLIENT_SECRET_FILE: clientSecretFile,
			PUBLIC_BASE_URL: "https://auth.example.test",
			AUTH_PROXY_KEY_FILE: proxyKeyFile,
		});

		assert.equal(config.clientSecret, "google-secret");
		assert.equal(config.authProxyKey, "proxy-secret");
	} finally {
		fs.rmSync(temporaryDirectory, {
			recursive: true,
			force: true,
		});
	}
});

test("configuration rejects simultaneous secret values and files", () => {
	assert.throws(
		() =>
			configFromEnv({
				GOOGLE_CLIENT_ID: "test-client-id",
				GOOGLE_CLIENT_SECRET: "direct-secret",
				GOOGLE_CLIENT_SECRET_FILE: "/unused",
				PUBLIC_BASE_URL: "https://auth.example.test",
				AUTH_PROXY_KEY: "proxy-secret",
			}),
		/Set either GOOGLE_CLIENT_SECRET or GOOGLE_CLIENT_SECRET_FILE, but not both/
	);
});

test("configuration rejects unreadable secret files", () => {
	const temporaryDirectory = fs.mkdtempSync(
		path.join(os.tmpdir(), "sync-drive-auth-")
	);

	try {
		assert.throws(
			() =>
				configFromEnv({
					GOOGLE_CLIENT_ID: "test-client-id",
					GOOGLE_CLIENT_SECRET_FILE: path.join(
						temporaryDirectory,
						"missing-secret"
					),
					PUBLIC_BASE_URL: "https://auth.example.test",
					AUTH_PROXY_KEY: "proxy-secret",
				}),
			/Unable to read GOOGLE_CLIENT_SECRET_FILE/
		);
	} finally {
		fs.rmSync(temporaryDirectory, {
			recursive: true,
			force: true,
		});
	}
});

test("GET /api/ping returns a JSON health response", async () => {
	const baseUrl = await startServer();
	const response = await fetch(`${baseUrl}/api/ping`);

	assert.equal(response.status, 200);
	assert.match(response.headers.get("content-type") || "", /application\/json/);
	assert.deepEqual(await response.json(), { ok: true });
	assert.equal(response.headers.get("cache-control"), "no-store");
});

test("unknown routes return JSON 404", async () => {
	const baseUrl = await startServer();
	const response = await fetch(`${baseUrl}/not-a-route`);

	assert.equal(response.status, 404);
	assert.deepEqual(await response.json(), { error: "not_found" });
});

test("CORS preflight advertises the expected methods and headers", async () => {
	const baseUrl = await startServer();
	const response = await fetch(`${baseUrl}/api/access`, {
		method: "OPTIONS",
		headers: {
			Origin: "app://obsidian.md",
			"Access-Control-Request-Method": "POST",
		},
	});

	assert.equal(response.status, 204);
	assert.equal(
		response.headers.get("access-control-allow-origin"),
		"app://obsidian.md"
	);
	assert.equal(
		response.headers.get("access-control-allow-methods"),
		"POST, OPTIONS"
	);
	assert.equal(
		response.headers.get("access-control-allow-headers"),
		"Content-Type, Authorization, X-Auth-Proxy-Key"
	);
});

test("/api/access rejects unsupported methods", async () => {
	const baseUrl = await startServer();
	const response = await fetch(`${baseUrl}/api/access`);

	assert.equal(response.status, 405);
	assert.deepEqual(await response.json(), { error: "method_not_allowed" });
});

test("missing and incorrect proxy keys return 401 without contacting Google", async () => {
	let googleRequests = 0;
	const baseUrl = await startServer({
		fetchImpl: async () => {
			googleRequests++;
			return jsonResponse({});
		},
	});

	for (const key of [undefined, "wrong-key"]) {
		const headers = { "Content-Type": "application/json" };
		if (key) headers["X-Auth-Proxy-Key"] = key;
		const response = await fetch(`${baseUrl}/api/access`, {
			method: "POST",
			headers,
			body: JSON.stringify({ refresh_token: "refresh-value" }),
		});
		assert.equal(response.status, 401);
		assert.deepEqual(await response.json(), { error: "unauthorized" });
	}

	assert.equal(googleRequests, 0);
});

test("invalid JSON and missing refresh tokens return 400", async () => {
	const baseUrl = await startServer();
	const headers = {
		"Content-Type": "application/json",
		"X-Auth-Proxy-Key": "test-proxy-key",
	};

	const invalidJson = await fetch(`${baseUrl}/api/access`, {
		method: "POST",
		headers,
		body: "{",
	});
	assert.equal(invalidJson.status, 400);
	assert.deepEqual(await invalidJson.json(), { error: "invalid_json" });

	for (const body of [{}, { refresh_token: "" }, null]) {
		const response = await fetch(`${baseUrl}/api/access`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), {
			error: "missing_refresh_token",
		});
	}
});

test("valid access requests send the correct form fields and return an access token", async () => {
	const calls = [];
	const baseUrl = await startServer({
		fetchImpl: async (url, options) => {
			calls.push({ url, options });
			return jsonResponse({
				access_token: "google-access-token",
				expires_in: 3599,
				scope: "drive.file",
				token_type: "Bearer",
				refresh_token: "must-not-be-forwarded",
			});
		},
	});

	const response = await fetch(`${baseUrl}/api/access`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Auth-Proxy-Key": "test-proxy-key",
		},
		body: JSON.stringify({ refresh_token: "plugin-refresh-token" }),
	});

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		access_token: "google-access-token",
		expires_in: 3599,
		scope: "drive.file",
		token_type: "Bearer",
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://oauth2.googleapis.com/token");
	assert.equal(calls[0].options.method, "POST");
	assert.equal(
		calls[0].options.headers["Content-Type"],
		"application/x-www-form-urlencoded"
	);
	assert.deepEqual(Object.fromEntries(calls[0].options.body), {
		refresh_token: "plugin-refresh-token",
		client_id: "test-client-id.apps.googleusercontent.com",
		client_secret: "test-client-secret",
		grant_type: "refresh_token",
	});
});

test("Google token errors preserve their status and JSON response", async () => {
	const baseUrl = await startServer({
		fetchImpl: async () =>
			jsonResponse(
				{
					error: "invalid_grant",
					error_description: "Token has been expired or revoked.",
				},
				400
			),
	});

	const response = await fetch(`${baseUrl}/api/access`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Auth-Proxy-Key": "test-proxy-key",
		},
		body: JSON.stringify({ refresh_token: "expired-token" }),
	});

	assert.equal(response.status, 400);
	assert.deepEqual(await response.json(), {
		error: "invalid_grant",
		error_description: "Token has been expired or revoked.",
	});
});

test("/auth redirects with OAuth parameters and a protected state cookie", async () => {
	const baseUrl = await startServer();
	const response = await fetch(`${baseUrl}/auth`, {
		redirect: "manual",
	});

	assert.equal(response.status, 302);
	const location = new URL(response.headers.get("location"));
	assert.equal(location.origin, "https://accounts.google.com");
	assert.equal(location.pathname, "/o/oauth2/v2/auth");
	assert.equal(
		location.searchParams.get("client_id"),
		"test-client-id.apps.googleusercontent.com"
	);
	assert.equal(
		location.searchParams.get("redirect_uri"),
		"https://auth.example.test/callback"
	);
	assert.equal(location.searchParams.get("response_type"), "code");
	assert.equal(
		location.searchParams.get("scope"),
		"https://www.googleapis.com/auth/drive.file"
	);
	assert.equal(location.searchParams.get("access_type"), "offline");
	assert.equal(location.searchParams.get("prompt"), "consent");
	assert.equal(location.searchParams.get("include_granted_scopes"), "true");
	assert.equal(location.searchParams.get("state"), "fixed-oauth-state");

	const cookie = response.headers.get("set-cookie") || "";
	assert.match(cookie, /sync_drive_oauth_state=fixed-oauth-state/);
	assert.match(cookie, /HttpOnly/);
	assert.match(cookie, /Secure/);
	assert.match(cookie, /SameSite=Lax/);
	assert.match(cookie, /Max-Age=600/);
});

test("/callback rejects missing codes and invalid OAuth state without contacting Google", async () => {
	let googleRequests = 0;
	const baseUrl = await startServer({
		fetchImpl: async () => {
			googleRequests++;
			return jsonResponse({});
		},
	});

	const missingCode = await fetch(
		`${baseUrl}/callback?state=fixed-oauth-state`,
		{
			headers: {
				Cookie: "sync_drive_oauth_state=fixed-oauth-state",
			},
		}
	);
	assert.equal(missingCode.status, 400);
	assert.match(await missingCode.text(), /No code was returned/);

	const invalidState = await fetch(
		`${baseUrl}/callback?code=auth-code&state=attacker-state`,
		{
			headers: {
				Cookie: "sync_drive_oauth_state=fixed-oauth-state",
			},
		}
	);
	assert.equal(invalidState.status, 400);
	assert.match(await invalidState.text(), /OAuth state check failed/);
	assert.equal(googleRequests, 0);
});

test("a valid callback exchanges the code and safely displays the refresh token", async () => {
	const calls = [];
	const dangerousToken = '</textarea><script>alert("x")</script>&';
	const baseUrl = await startServer({
		fetchImpl: async (url, options) => {
			calls.push({ url, options });
			return jsonResponse({ refresh_token: dangerousToken });
		},
	});

	const response = await fetch(
		`${baseUrl}/callback?code=authorization-code&state=fixed-oauth-state`,
		{
			headers: {
				Cookie: "sync_drive_oauth_state=fixed-oauth-state",
			},
		}
	);
	const html = await response.text();

	assert.equal(response.status, 200);
	assert.equal(calls.length, 1);
	assert.deepEqual(Object.fromEntries(calls[0].options.body), {
		code: "authorization-code",
		client_id: "test-client-id.apps.googleusercontent.com",
		client_secret: "test-client-secret",
		redirect_uri: "https://auth.example.test/callback",
		grant_type: "authorization_code",
	});
	assert.doesNotMatch(html, /<\/textarea><script>/);
	assert.match(
		html,
		/&lt;\/textarea&gt;&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;&amp;/
	);
});

test("a successful callback response without a refresh token explains how to retry", async () => {
	const baseUrl = await startServer({
		fetchImpl: async () =>
			jsonResponse({
				access_token: "access-only",
				expires_in: 3600,
			}),
	});

	const response = await fetch(
		`${baseUrl}/callback?code=authorization-code&state=fixed-oauth-state`,
		{
			headers: {
				Cookie: "sync_drive_oauth_state=fixed-oauth-state",
			},
		}
	);
	const html = await response.text();

	assert.equal(response.status, 400);
	assert.match(html, /No refresh token returned/);
	assert.match(html, /Revoke this app/);
	assert.match(html, /retry \/auth/);
});
