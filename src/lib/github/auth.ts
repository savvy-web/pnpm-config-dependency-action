/**
 * GitHub App authentication utilities.
 *
 * @module github/auth
 */

import { context } from "@actions/github";
import { createAppAuth } from "@octokit/auth-app";
import { request } from "@octokit/request";
import { Effect } from "effect";

import type { InstallationToken } from "../../types/index.js";
import { AuthenticationError } from "../errors/types.js";

/**
 * Generate an installation token from GitHub App credentials.
 */
export const generateInstallationToken = (
	appId: string,
	privateKey: string,
): Effect.Effect<InstallationToken, AuthenticationError> =>
	Effect.gen(function* () {
		yield* Effect.logInfo("Generating GitHub App installation token...");

		// Create app auth
		const auth = createAppAuth({
			appId,
			privateKey,
			request,
		});

		// Get JWT for app authentication
		const appAuth = yield* Effect.tryPromise({
			try: () => auth({ type: "app" }),
			catch: (e) =>
				new AuthenticationError({
					reason: `Failed to authenticate as GitHub App: ${e}`,
					appId,
				}),
		});

		yield* Effect.logDebug(`App authenticated, getting installation for ${context.repo.owner}/${context.repo.repo}`);

		// Get installation ID for this repository
		const installationId = yield* Effect.tryPromise({
			try: async () => {
				const response = await request("GET /repos/{owner}/{repo}/installation", {
					owner: context.repo.owner,
					repo: context.repo.repo,
					headers: {
						authorization: `Bearer ${appAuth.token}`,
					},
				});
				return response.data.id;
			},
			catch: (e) =>
				new AuthenticationError({
					reason: `Failed to get installation ID: ${e}. Ensure the GitHub App is installed on this repository.`,
					appId,
				}),
		});

		yield* Effect.logDebug(`Installation ID: ${installationId}`);

		// Generate installation token
		const installationAuth = yield* Effect.tryPromise({
			try: () =>
				auth({
					type: "installation",
					installationId,
				}),
			catch: (e) =>
				new AuthenticationError({
					reason: `Failed to generate installation token: ${e}`,
					appId,
				}),
		});

		// Get app slug for logging
		const appSlug = yield* Effect.tryPromise({
			try: async () => {
				const response = await request("GET /app", {
					headers: {
						authorization: `Bearer ${appAuth.token}`,
					},
				});
				return response.data?.slug ?? "unknown";
			},
			catch: () =>
				new AuthenticationError({
					reason: "Failed to get app slug",
					appId,
				}),
		}).pipe(Effect.catchAll(() => Effect.succeed("unknown")));

		yield* Effect.logInfo(`Token generated for app "${appSlug}" (expires: ${installationAuth.expiresAt})`);

		return {
			token: installationAuth.token,
			expiresAt: installationAuth.expiresAt ?? new Date(Date.now() + 3600000).toISOString(),
			installationId,
			appSlug,
		};
	});

/**
 * Revoke an installation token.
 */
export const revokeInstallationToken = (token: string): Effect.Effect<void, AuthenticationError> =>
	Effect.tryPromise({
		try: async () => {
			await request("DELETE /installation/token", {
				headers: {
					authorization: `Bearer ${token}`,
				},
			});
		},
		catch: (e) =>
			new AuthenticationError({
				reason: `Failed to revoke token: ${e}`,
			}),
	});
