import ky, { Hooks } from "ky";
import ObsidianGoogleDrive from "main";
import { Notice } from "obsidian";
import { refreshAccessToken } from "./auth";

const getHooks = (t: ObsidianGoogleDrive): Hooks => ({
	beforeRequest: [
		async (request) => {
			if (t.accessToken.token) {
				if (t.accessToken.expiresAt - Date.now() < 60000) {
					const result = await refreshAccessToken(t);
					if (!result.ok) return request;
				}
				request.headers.set(
					"Authorization",
					`Bearer ${t.accessToken.token}`
				);
			}
			return request;
		},
	],
	afterResponse: [
		async (request, options, response) => {
			if (!response.ok) {
				new Notice(`Error: ${await response.text()}`);
				return new Response();
			}
			return response;
		},
	],
});

export const getDriveKy = (t: ObsidianGoogleDrive) => {
	return ky.extend({
		prefixUrl: "https://www.googleapis.com",
		hooks: getHooks(t),
		timeout: 120_000,
	});
};
