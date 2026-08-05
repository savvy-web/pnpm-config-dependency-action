/**
 * Release-age gate: the effective pnpm `minimumReleaseAge` policy, mirrored at
 * resolution time.
 *
 * pnpm rejects versions published inside the cutoff window at install
 * (`ERR_PNPM_NO_MATURE_MATCHING_VERSION`). The action applies the same gate
 * when resolving, so it never proposes a version pnpm would refuse.
 *
 * **Discovery belongs to `@effected/workspaces`.** `WorkspaceCatalogs.releaseAgeGate()`
 * combines the inline `pnpm-workspace.yaml` keys with the replayed
 * config-dependency `pnpmfile` hooks, strictest-wins, off the same single read it
 * uses for the catalog set. Replaying hooks matters because `pnpm config get`
 * does not, so a repo receiving its settings through a config dependency can
 * only be read that way.
 *
 * The hook replay must run in a **subprocess** — `layerWithConfigDependenciesSubprocess`,
 * not `layerWithConfigDependencies` — because rspack miscompiles a computed
 * dynamic `import()` into a context module (see the `action.config.ts` note on
 * `nativeDynamicImports`). The subprocess variant passes a static script via
 * argv, so nothing computed enters the bundle graph. It also keeps
 * config-dependency code out of the action's own process.
 *
 * **What stays local is the fail-open posture.** The kit fails *typed* with
 * `CatalogAssemblyFailure`, which is correct for a library. This action instead
 * degrades to "no gate" with a warning, because pnpm re-enforces the gate at
 * install and the worst case of missing data is exactly the pre-gate behavior —
 * whereas aborting a dependency-update run over an unreadable workspace file
 * would be a strictly worse trade. That wrapper is at the one call site in
 * `ReleaseAgeLive`.
 *
 * @module services/release-age
 */

import { NpmRegistry, ReleaseAgeGate } from "@effected/npm";
import { WorkspaceCatalogs } from "@effected/workspaces";
import { Context, DateTime, Effect, Layer } from "effect";

export type { PartialReleaseAgeGate } from "@effected/npm";

/**
 * Fetch a package's publish times, normalized to `version → ISO-8601`.
 *
 * Fails open: a registry failure yields `{}` with a warning, which the caller
 * treats as "cannot filter" rather than as an error.
 */
export const getPublishTimes = (pkg: string): Effect.Effect<Record<string, string>, never, NpmRegistry> =>
	Effect.gen(function* () {
		const registry = yield* NpmRegistry;
		const published = yield* registry.publishTimes(pkg).pipe(Effect.catch(() => Effect.succeed(null)));
		if (published === null) {
			yield* Effect.logWarning(`Failed to fetch publish times for ${pkg}; release-age filtering unavailable`);
			return {};
		}

		const times: Record<string, string> = {};
		for (const entry of published) {
			times[entry.version] = DateTime.formatIso(entry.publishedAt);
		}
		return times;
	});

// ══════════════════════════════════════════════════════════════════════════════
// Service Interface
// ══════════════════════════════════════════════════════════════════════════════

/**
 * The effective release-age gate for the workspace, applied to candidate
 * version lists before resolution so the action never proposes a version
 * pnpm's own `minimumReleaseAge` check would refuse at install time.
 */
export class ReleaseAge extends Context.Service<
	ReleaseAge,
	{
		/** The effective gate (inline + hook sources, strictest wins). */
		readonly gate: () => Effect.Effect<ReleaseAgeGate>;
		/**
		 * Drop candidate versions of `pkg` younger than the gate's cutoff.
		 * Identity when the gate is inert, the package is excluded, or publish
		 * times are unavailable (fail open — worst case is today's behavior).
		 */
		readonly filterVersions: (pkg: string, versions: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>>;
	}
>()("ReleaseAge") {}

/**
 * Live layer factory. The workspace root is bound when the layer is built
 * (mirroring the `@effected/workspaces` root-bound layer idiom); the gate is
 * assembled once on first use and cached for the layer's lifetime.
 */
export const ReleaseAgeLive = (): Layer.Layer<ReleaseAge, never, WorkspaceCatalogs | NpmRegistry> =>
	Layer.effect(
		ReleaseAge,
		Effect.gen(function* () {
			// Both dependencies are resolved once here, so every member's R is
			// `never` — which is what keeps `filterVersions` usable from the
			// ConfigDeps/RegularDeps call sites without threading requirements.
			const catalogs = yield* WorkspaceCatalogs;
			const registry = yield* NpmRegistry;

			const assembleGate = Effect.gen(function* () {
				// Discovery is the kit's: `releaseAgeGate()` combines the inline
				// `pnpm-workspace.yaml` keys with the replayed config-dependency hooks,
				// strictest-wins, off the same single read it uses for the catalog set.
				//
				// **The fail-open posture stays ours.** The kit fails *typed* with
				// `CatalogAssemblyFailure`, which is the right contract for a library —
				// but this action deliberately degrades to "no gate" instead, because
				// pnpm re-enforces the gate at install and the worst case of missing
				// data is exactly the pre-gate behavior. Aborting a dependency-update
				// run because a workspace file could not be assembled would be a
				// strictly worse trade.
				const gate = yield* catalogs.releaseAgeGate().pipe(
					Effect.catch((error) =>
						Effect.gen(function* () {
							yield* Effect.logWarning(
								`Release-age gate discovery failed (${error._tag}); proceeding with no gate. ` +
									"pnpm still enforces minimumReleaseAge at install.",
							);
							return ReleaseAgeGate.combine();
						}),
					),
				);

				if (gate.ageMinutes > 0) {
					yield* Effect.logInfo(
						`Release-age gate active: ${gate.ageMinutes} minute minimum, ${gate.exclude.length} exclude pattern(s)`,
					);
				}
				return gate;
			});
			const cachedGate = yield* Effect.cached(assembleGate);

			const filterVersions = (
				pkg: string,
				versions: ReadonlyArray<string>,
			): Effect.Effect<ReadonlyArray<string>, never, never> =>
				Effect.gen(function* () {
					const gate = yield* cachedGate;
					if (gate.ageMinutes <= 0 || gate.isExcluded(pkg)) {
						return versions;
					}

					const times = yield* getPublishTimes(pkg).pipe(Effect.provideService(NpmRegistry, registry));
					// Fail open on missing publish-time data: pnpm would fail closed,
					// but for resolution-time mirroring the worst case of proposing an
					// unverifiable version is exactly today's behavior — and a warning
					// was already logged by getPublishTimes.
					if (Object.keys(times).length === 0) {
						return versions;
					}

					const eligible = gate.filterVersions([...versions], times, pkg, Date.now());
					const dropped = versions.length - eligible.length;
					if (dropped > 0) {
						yield* Effect.logInfo(
							`Release-age gate: holding back ${dropped} version(s) of ${pkg} younger than ${gate.ageMinutes} minutes`,
						);
					}
					return eligible;
				});

			return {
				gate: () => cachedGate,
				filterVersions,
			};
		}),
	);

/**
 * Inert test layer: the zero gate, identity filtering. What non-pnpm and
 * unit-test paths should wire.
 */
export const ReleaseAgeNoop: Layer.Layer<ReleaseAge> = Layer.succeed(ReleaseAge, {
	gate: () => Effect.succeed(ReleaseAgeGate.combine()),
	filterVersions: (_pkg, versions) => Effect.succeed(versions),
});
