/**
 * Step: sync peerDependency ranges after the regular-dependency pass.
 *
 * `peer-lock` syncs the peer range on every version bump; `peer-minor` only on
 * minor-or-greater bumps, flooring the patch to `.0`. Runs after regular
 * dependencies because it consumes their results — a peer range is synced *to*
 * whatever the dependency was just bumped to.
 *
 * **Failure posture: fail-the-job.** `syncPeers` fails with `FileSystemError`
 * when a manifest cannot be read or written, which is not recoverable here.
 *
 * @module steps/peer-sync
 */

import type { WorkspaceDiscovery } from "@effected/workspaces";
import { Effect } from "effect";
import type { FileSystemError } from "../errors/errors.js";
import type { DependencyUpdateResult } from "../schema/domain.js";
import type { PeerSyncConfig } from "../services/peer-sync.js";
import { syncPeers } from "../services/peer-sync.js";

/**
 * The peer ranges this step rewrote, plus whether the step was configured at
 * all — the closing Result block reports "not configured" distinctly from
 * "configured and synced nothing".
 */
export interface PeerSyncResult {
	readonly updates: ReadonlyArray<DependencyUpdateResult>;
	readonly configured: boolean;
}

/**
 * Sync peer ranges for the packages the two peer inputs name.
 *
 * Takes no workspace root: `WorkspaceDiscovery` binds its root when the layer
 * is built, so a root parameter here could only be ignored. It previously was —
 * silently, which is the problem: a caller passing the wrong root would see no
 * error and no effect, and a reader would reasonably conclude the root was
 * honoured.
 */
export const peerSyncStep = (
	config: PeerSyncConfig,
	regularUpdates: ReadonlyArray<DependencyUpdateResult>,
): Effect.Effect<PeerSyncResult, FileSystemError, WorkspaceDiscovery> =>
	Effect.gen(function* () {
		const configured = config.lock.length > 0 || config.minor.length > 0;

		if (!configured) {
			yield* Effect.logInfo("Step: peer sync — SKIPPED: no peer-lock or peer-minor patterns configured");
			return { updates: [], configured };
		}

		yield* Effect.logInfo(
			`Step: peer sync — peer-lock ${config.lock.join(", ") || "none"} · peer-minor ${
				config.minor.join(", ") || "none"
			}`,
		);
		const updates = yield* syncPeers(config, regularUpdates);
		yield* Effect.logInfo(`  synced ${updates.length} peer dependency range(s)`);

		return { updates, configured };
	});
