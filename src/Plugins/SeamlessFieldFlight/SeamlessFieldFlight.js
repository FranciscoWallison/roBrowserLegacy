/**
 * Plugins/SeamlessFieldFlight/SeamlessFieldFlight.js
 *
 * Seamless map transitions (no loading screen) across ALL walk-into portals.
 * As the player approaches a warp tile, the destination map is preloaded in the
 * background; when the warp fires, that map is swapped in instantly under a
 * short fade instead of the full unload/reload + loading bar.
 *
 * 100% runtime monkey-patching: it wraps MapRenderer.setMap / free / onRender
 * and Thread.hook, and touches no engine logic at rest. The only supporting
 * piece outside this folder is the worker's PRELOAD_MAP command (a fresh worker
 * cannot be initialised from a plugin, so preloading reuses the main worker).
 *
 * Scope: every static portal whose move stays on the same map-server
 * (ZC_NPCACK_MAPMOVE). Instant teleports (@warp / kafra / save) and cross-server
 * moves are not preloadable and fall back to the normal loading screen. The
 * actual move is still the server's warp; this plugin only suppresses the
 * loading screen and swaps the cached resources in.
 *
 * Enable in Config.local.js:
 *
 *   plugins: {
 *       SeamlessFieldFlight: { path: 'SeamlessFieldFlight/SeamlessFieldFlight' }
 *   }
 *
 * Optional config keys:
 *   enableSeamlessFlight   (boolean, default true)  master on/off
 *   seamlessCacheSize      (number,  default 1)      destination payloads kept
 *   seamlessPreloadDistance(number,  default 30)     cells from a portal to preload
 *   seamlessFadeDuration   (number,  default 200)    fade half-duration in ms
 *   seamlessDebug          (boolean, default true)   log transitions to console
 */

import Thread from 'Core/Thread.js';
import Configs from 'Core/Configs.js';
import Session from 'Engine/SessionStorage.js';
import MapRenderer from 'Renderer/MapRenderer.js';

import PortalGraph from './PortalGraph.js';
import MapCache from './MapCache.js';
import Preloader from './Preloader.js';
import Swap from './Swap.js';

const DEFAULT_PORTAL_DISTANCE = 30;
const THROTTLE_FRAMES = 20;

let _installed = false;

// Portal-proximity trigger state.
let _lastMap = '';
let _warps = null;
let _frame = 0;

function norm(name) {
	return String(name || '').replace(/\.(gat|rsw)$/i, '').toLowerCase();
}

function portalDistance() {
	const v = Configs.get('seamlessPreloadDistance');
	return typeof v === 'number' && v > 0 ? v : DEFAULT_PORTAL_DISTANCE;
}

/**
 * Per-frame portal-proximity check (cheap + throttled). Preloads the destination
 * of the nearest portal tile within range of the player.
 *
 * @param {string} currentMap
 * @param {ArrayLike<number>} position
 */
function portalTick(currentMap, position) {
	if (!PortalGraph.isEnabled() || !currentMap || !position) {
		return;
	}
	if (++_frame % THROTTLE_FRAMES !== 0) {
		return;
	}

	if (currentMap !== _lastMap) {
		_lastMap = currentMap;
		_warps = PortalGraph.getWarps(currentMap);
	}
	if (!_warps || !_warps.length) {
		return;
	}

	const x = position[0];
	const y = position[1];
	const maxSq = portalDistance() * portalDistance();

	// Preload the destination of the nearest in-range portal.
	let bestSq = Infinity;
	let bestDst = null;
	for (let i = 0; i < _warps.length; ++i) {
		const w = _warps[i];
		const dx = w[0] - x;
		const dy = w[1] - y;
		const d2 = dx * dx + dy * dy;
		if (d2 <= maxSq && d2 < bestSq) {
			bestSq = d2;
			bestDst = w[2];
		}
	}

	if (bestDst) {
		Preloader.preload(bestDst); // no-op if cached/loading
	}
}

/**
 * Plugin entry. Installs all hooks.
 *
 * @returns {boolean} true on success
 */
export default function SeamlessFieldFlightPlugin() {
	try {
		if (_installed) {
			return true;
		}
		_installed = true;

		MapCache.setMaxEntries(Configs.get('seamlessCacheSize') || 1);
		Preloader.init();

		// 1) Capture the engine's live map-build handlers as they are registered,
		//    so the swap can replay them with cached data (no GL reimplementation).
		const _origHook = Thread.hook;
		Thread.hook = function (type, callback) {
			if (callback) {
				Swap.captureHandler(type, callback);
			}
			return _origHook.call(Thread, type, callback);
		};

		// 2) Intercept map changes: if the target is a preloaded adjacent field,
		//    swap it in instantly. Runs before the original setMap's UI teardown.
		const _origSetMap = MapRenderer.setMap;
		MapRenderer.setMap = function (mapname) {
			if (!MapRenderer.loading) {
				const target = norm(mapname);
				if (MapRenderer.currentMap !== target && PortalGraph.isSeamlessEligible(MapRenderer.currentMap, target)) {
					if (MapCache.has(target) && Swap.performSwap(target)) {
						return undefined;
					}
					if (Configs.get('seamlessDebug') !== false) {
						console.log(
							'%c[SeamlessFlight] load normal → ' + target + ' (nao pre-carregado a tempo)',
							'color:#FF9800'
						);
					}
				}
			}
			return _origSetMap.call(MapRenderer, mapname);
		};

		// 3) A full (non-seamless) reload breaks the seamless chain: drop the
		//    cache and any in-flight preload.
		const _origFree = MapRenderer.free;
		MapRenderer.free = function () {
			try {
				Preloader.cancel();
				MapCache.clear();
			} catch (e) {
				/* ignore */
			}
			return _origFree.call(this);
		};

		// 4) Drive the edge-proximity preload from the render loop.
		const _origOnRender = MapRenderer.onRender;
		MapRenderer.onRender = function (tick, gl) {
			try {
				portalTick(MapRenderer.currentMap, Session.Entity && Session.Entity.position);
			} catch (e) {
				/* never break rendering */
			}
			return _origOnRender.call(MapRenderer, tick, gl);
		};

		console.log('%c[SeamlessFieldFlight] Plugin initialized', 'color: #4CAF50; font-weight: bold');
		return true;
	} catch (e) {
		console.error('[SeamlessFieldFlight] Plugin initialization failed:', e);
		return false;
	}
}
