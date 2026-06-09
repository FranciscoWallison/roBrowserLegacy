/**
 * Plugins/SeamlessFieldFlight/SeamlessFieldFlight.js
 *
 * Seamless field-to-field map transitions (no loading screen). When the player
 * crosses an open-field border, the neighbouring field — preloaded in the
 * background as the player nears the edge — is swapped in instantly under a
 * short fade, instead of the full unload/reload + loading bar.
 *
 * 100% runtime monkey-patching: it wraps MapRenderer.setMap / free / onRender
 * and Thread.hook, and touches no engine logic at rest. The only supporting
 * piece outside this folder is the worker's PRELOAD_MAP command (a fresh worker
 * cannot be initialised from a plugin, so preloading reuses the main worker).
 *
 * Scope: field <-> field only (towns/dungeons fall back to the normal loading
 * screen). The actual cross-map move is still the server's existing border warp;
 * this plugin only suppresses the loading screen and swaps cached resources in.
 *
 * Enable in Config.local.js:
 *
 *   plugins: {
 *       SeamlessFieldFlight: { path: 'SeamlessFieldFlight/SeamlessFieldFlight' }
 *   }
 *
 * Optional config keys:
 *   enableSeamlessFlight   (boolean, default true)  master on/off
 *   seamlessCacheSize      (number,  default 1)      neighbour payloads kept
 *   seamlessPreloadDistance(number,  default 30)     cells from a seam to preload
 */

import Thread from 'Core/Thread.js';
import Configs from 'Core/Configs.js';
import Session from 'Engine/SessionStorage.js';
import MapRenderer from 'Renderer/MapRenderer.js';

import FieldNeighbors from './FieldNeighbors.js';
import MapCache from './MapCache.js';
import Preloader from './Preloader.js';
import Swap from './Swap.js';

const DEFAULT_EDGE_DISTANCE = 30;
const THROTTLE_FRAMES = 20;

let _installed = false;

// Edge-trigger state.
let _lastMap = '';
let _neighbors = null;
let _frame = 0;

function norm(name) {
	return String(name || '').replace(/\.(gat|rsw)$/i, '').toLowerCase();
}

function edgeDistance() {
	const v = Configs.get('seamlessPreloadDistance');
	return typeof v === 'number' && v > 0 ? v : DEFAULT_EDGE_DISTANCE;
}

/**
 * Per-frame edge-proximity check (cheap + throttled). Preloads the neighbour
 * field when the player nears a known seam.
 *
 * @param {string} currentMap
 * @param {ArrayLike<number>} position
 */
function edgeTick(currentMap, position) {
	if (!FieldNeighbors.isEnabled() || !currentMap || !position) {
		return;
	}
	if (++_frame % THROTTLE_FRAMES !== 0) {
		return;
	}

	if (currentMap !== _lastMap) {
		_lastMap = currentMap;
		const record = FieldNeighbors.getNeighbors(currentMap);
		_neighbors = record && record.neighbors ? record.neighbors : null;
	}
	if (!_neighbors) {
		return;
	}

	const x = position[0];
	const y = position[1];
	const dist = edgeDistance();

	for (let i = 0; i < _neighbors.length; ++i) {
		const edge = _neighbors[i].edge;
		if (!edge) {
			continue;
		}
		const coord = edge.axis === 'x' ? x : y;
		if (Math.abs(coord - edge.at) <= dist) {
			Preloader.preload(_neighbors[i].map); // no-op if cached/loading
			break;
		}
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
				if (
					MapRenderer.currentMap !== target &&
					MapCache.has(target) &&
					FieldNeighbors.isSeamlessEligible(MapRenderer.currentMap, target) &&
					Swap.performSwap(target)
				) {
					return undefined;
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
				edgeTick(MapRenderer.currentMap, Session.Entity && Session.Entity.position);
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
