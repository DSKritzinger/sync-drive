const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const normalizeAuthServerUrl = (value: string): string => {
	const input = value.trim();
	if (!input) {
		throw new Error("Enter the auth server URL.");
	}

	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new Error("Enter a valid auth server URL.");
	}

	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error("The auth server URL must use HTTPS.");
	}
	if (!url.hostname || url.username || url.password || url.search || url.hash) {
		throw new Error(
			"The auth server URL cannot contain credentials, a query, or a fragment."
		);
	}
	if (
		url.protocol === "http:" &&
		!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
	) {
		throw new Error(
			"HTTP is only allowed for localhost, 127.0.0.1, or [::1]."
		);
	}

	const pathname = url.pathname.replace(/\/+$/, "");
	return `${url.origin}${pathname === "/" ? "" : pathname}`;
};

