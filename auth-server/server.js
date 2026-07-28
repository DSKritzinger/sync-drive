import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SCOPE = "https://www.googleapis.com/auth/drive.file";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const STATE_COOKIE = "sync_drive_oauth_state";

export const loadDotEnv = (
	filePath = path.join(path.dirname(fileURLToPath(import.meta.url)), ".env"),
	env = process.env
) => {
	if (!fs.existsSync(filePath)) return;

	const content = fs.readFileSync(filePath, "utf8");
	for (const line of content.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		const separator = trimmed.indexOf("=");
		if (separator === -1) continue;

		const key = trimmed.slice(0, separator).trim();
		let value = trimmed.slice(separator + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}

		if (key && env[key] === undefined) {
			env[key] = value;
		}
	}
};

const requiredString = (value, name) => {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`Missing required configuration: ${name}`);
	}
	return value.trim();
};

export const validateConfig = (input) => {
	const publicBaseUrlValue = requiredString(
		input.publicBaseUrl,
		"PUBLIC_BASE_URL"
	).replace(/\/+$/, "");
	let publicBaseUrl;
	try {
		const url = new URL(publicBaseUrlValue);
		if (
			(url.protocol !== "https:" && url.protocol !== "http:") ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		) {
			throw new Error();
		}
		publicBaseUrl = `${url.origin}${
			url.pathname.replace(/\/+$/, "") === "/"
				? ""
				: url.pathname.replace(/\/+$/, "")
		}`;
	} catch {
		throw new Error("PUBLIC_BASE_URL must be a valid HTTP(S) URL.");
	}

	const requireAuthProxyKey = input.requireAuthProxyKey !== false;
	const authProxyKey =
		typeof input.authProxyKey === "string" ? input.authProxyKey : "";
	if (requireAuthProxyKey && !authProxyKey) {
		throw new Error(
			"Set AUTH_PROXY_KEY or set REQUIRE_AUTH_PROXY_KEY=false for local-only testing."
		);
	}

	const port = Number(input.port ?? 8787);
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error("PORT must be an integer from 0 to 65535.");
	}

	const allowedOrigins = Array.isArray(input.allowedOrigins)
		? input.allowedOrigins.filter(
				(value) => typeof value === "string" && value
		  )
		: ["*"];

	return Object.freeze({
		clientId: requiredString(input.clientId, "GOOGLE_CLIENT_ID"),
		clientSecret: requiredString(
			input.clientSecret,
			"GOOGLE_CLIENT_SECRET"
		),
		publicBaseUrl,
		scope:
			typeof input.scope === "string" && input.scope
				? input.scope
				: DEFAULT_SCOPE,
		authProxyKey,
		requireAuthProxyKey,
		allowedOrigins: allowedOrigins.length ? allowedOrigins : ["*"],
		secureCookies: input.secureCookies !== false,
		port,
	});
};

export const configFromEnv = (env = process.env) =>
	validateConfig({
		clientId: env.GOOGLE_CLIENT_ID,
		clientSecret: env.GOOGLE_CLIENT_SECRET,
		publicBaseUrl: env.PUBLIC_BASE_URL,
		scope: env.GOOGLE_DRIVE_SCOPE,
		authProxyKey: env.AUTH_PROXY_KEY,
		requireAuthProxyKey: env.REQUIRE_AUTH_PROXY_KEY !== "false",
		allowedOrigins: (env.ALLOWED_ORIGINS || "*")
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean),
		secureCookies: env.SECURE_COOKIES !== "false",
		port: env.PORT || 8787,
	});

const send = (res, status, body, headers = {}) => {
	res.writeHead(status, {
		"Cache-Control": "no-store",
		...headers,
	});
	res.end(body);
};

const sendJson = (res, status, body, headers = {}) =>
	send(res, status, JSON.stringify(body), {
		"Content-Type": "application/json",
		...headers,
	});

const sendHtml = (res, status, body, headers = {}) =>
	send(res, status, body, {
		"Content-Type": "text/html; charset=UTF-8",
		...headers,
	});

const escapeHtml = (value) =>
	String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");

const getCookie = (req, name) => {
	const cookies = req.headers.cookie || "";
	for (const cookie of cookies.split(";")) {
		const [key, ...parts] = cookie.trim().split("=");
		if (key === name) return decodeURIComponent(parts.join("="));
	}
	return "";
};

const getJsonBody = async (req) => {
	const chunks = [];
	let size = 0;

	for await (const chunk of req) {
		size += chunk.length;
		if (size > 16 * 1024) {
			throw new Error("request_body_too_large");
		}
		chunks.push(chunk);
	}

	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const keysMatch = (actual, expected) => {
	if (typeof actual !== "string") return false;
	const actualBuffer = Buffer.from(actual);
	const expectedBuffer = Buffer.from(expected);
	return (
		actualBuffer.length === expectedBuffer.length &&
		crypto.timingSafeEqual(actualBuffer, expectedBuffer)
	);
};

export const createServer = (
	config,
	{
		fetchImpl = globalThis.fetch,
		stateGenerator = () => crypto.randomUUID(),
		logger = console,
	} = {}
) => {
	if (typeof fetchImpl !== "function") {
		throw new Error("A fetch implementation is required.");
	}
	if (typeof stateGenerator !== "function") {
		throw new Error("A state generator is required.");
	}

	const redirectUri = `${config.publicBaseUrl}/callback`;

	const getCorsHeaders = (req) => {
		const origin = req.headers.origin || "";
		const allowOrigin = config.allowedOrigins.includes("*")
			? "*"
			: config.allowedOrigins.includes(origin)
			? origin
			: "";

		const headers = {
			"Access-Control-Allow-Methods": "POST, OPTIONS",
			"Access-Control-Allow-Headers":
				"Content-Type, Authorization, X-Auth-Proxy-Key",
		};
		if (allowOrigin) {
			headers["Access-Control-Allow-Origin"] = allowOrigin;
		}
		return headers;
	};

	const exchangeToken = (params) =>
		fetchImpl(GOOGLE_TOKEN_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams(params),
		});

	const handleAuth = (req, res) => {
		if (req.method !== "GET") {
			return sendJson(res, 405, { error: "method_not_allowed" });
		}

		const state = stateGenerator();
		const authUrl = new URL(GOOGLE_AUTH_URL);
		authUrl.search = new URLSearchParams({
			client_id: config.clientId,
			redirect_uri: redirectUri,
			response_type: "code",
			scope: config.scope,
			access_type: "offline",
			prompt: "consent",
			include_granted_scopes: "true",
			state,
		}).toString();

		const secure = config.secureCookies ? "; Secure" : "";
		send(res, 302, "", {
			Location: authUrl.toString(),
			"Set-Cookie": `${STATE_COOKIE}=${encodeURIComponent(
				state
			)}; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=600`,
		});
	};

	const handleCallback = async (req, res, url) => {
		if (req.method !== "GET") {
			return sendJson(res, 405, { error: "method_not_allowed" });
		}

		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");
		const expectedState = getCookie(req, STATE_COOKIE);

		if (!code) {
			return sendHtml(
				res,
				400,
				"<h1>Authorization failed</h1><p>No code was returned.</p>"
			);
		}
		if (!state || !expectedState || state !== expectedState) {
			return sendHtml(
				res,
				400,
				"<h1>Authorization failed</h1><p>The OAuth state check failed. Start again from /auth.</p>"
			);
		}

		const response = await exchangeToken({
			code,
			client_id: config.clientId,
			client_secret: config.clientSecret,
			redirect_uri: redirectUri,
			grant_type: "authorization_code",
		});
		const token = await response.json();

		if (!response.ok) {
			return sendHtml(
				res,
				400,
				`<h1>Token exchange failed</h1><pre>${escapeHtml(
					JSON.stringify(token, null, 2)
				)}</pre>`
			);
		}
		if (!token.refresh_token) {
			return sendHtml(
				res,
				400,
				"<h1>No refresh token returned</h1><p>Revoke this app in your Google account permissions, then retry /auth. Google may only return a refresh token the first time you grant consent.</p>"
			);
		}

		return sendHtml(
			res,
			200,
			`<!doctype html>
<html>
	<head>
		<meta charset="utf-8">
		<title>Sync Drive refresh token</title>
		<style>
			body { font-family: system-ui, sans-serif; margin: 2rem; max-width: 760px; }
			textarea { box-sizing: border-box; font: 14px monospace; height: 12rem; width: 100%; }
		</style>
	</head>
	<body>
		<h1>Refresh token</h1>
		<p>Paste this token into the Sync Drive plugin settings. Do not share it.</p>
		<textarea readonly>${escapeHtml(token.refresh_token)}</textarea>
	</body>
</html>`
		);
	};

	const handleAccess = async (req, res) => {
		const corsHeaders = getCorsHeaders(req);
		if (req.method !== "POST") {
			return sendJson(
				res,
				405,
				{ error: "method_not_allowed" },
				corsHeaders
			);
		}
		if (
			config.requireAuthProxyKey &&
			!keysMatch(
				req.headers["x-auth-proxy-key"],
				config.authProxyKey
			)
		) {
			return sendJson(
				res,
				401,
				{ error: "unauthorized" },
				corsHeaders
			);
		}

		let body;
		try {
			body = await getJsonBody(req);
		} catch {
			return sendJson(
				res,
				400,
				{ error: "invalid_json" },
				corsHeaders
			);
		}
		if (
			!body ||
			typeof body !== "object" ||
			typeof body.refresh_token !== "string" ||
			!body.refresh_token
		) {
			return sendJson(
				res,
				400,
				{ error: "missing_refresh_token" },
				corsHeaders
			);
		}

		const response = await exchangeToken({
			refresh_token: body.refresh_token,
			client_id: config.clientId,
			client_secret: config.clientSecret,
			grant_type: "refresh_token",
		});
		const token = await response.json();

		if (!response.ok) {
			return sendJson(res, response.status, token, corsHeaders);
		}
		return sendJson(
			res,
			200,
			{
				access_token: token.access_token,
				expires_in: token.expires_in,
				scope: token.scope,
				token_type: token.token_type,
			},
			corsHeaders
		);
	};

	return http.createServer(async (req, res) => {
		try {
			const url = new URL(req.url || "/", config.publicBaseUrl);

			if (req.method === "OPTIONS") {
				return send(res, 204, "", getCorsHeaders(req));
			}
			if (url.pathname === "/api/ping") {
				if (req.method !== "GET") {
					return sendJson(
						res,
						405,
						{ error: "method_not_allowed" },
						getCorsHeaders(req)
					);
				}
				return sendJson(
					res,
					200,
					{ ok: true },
					getCorsHeaders(req)
				);
			}
			if (url.pathname === "/api/access") {
				return handleAccess(req, res);
			}
			if (url.pathname === "/auth") {
				return handleAuth(req, res);
			}
			if (url.pathname === "/callback") {
				return handleCallback(req, res, url);
			}
			return sendJson(res, 404, { error: "not_found" });
		} catch (error) {
			logger.error(error instanceof Error ? error.message : error);
			if (!res.headersSent) {
				return sendJson(res, 500, {
					error: "internal_server_error",
				});
			}
			res.end();
		}
	});
};

const isExecutableEntry =
	process.argv[1] &&
	path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isExecutableEntry) {
	loadDotEnv();
	const config = configFromEnv();
	const server = createServer(config);
	server.listen(config.port, () => {
		console.log(`Sync Drive auth server listening on ${config.port}`);
	});
}
