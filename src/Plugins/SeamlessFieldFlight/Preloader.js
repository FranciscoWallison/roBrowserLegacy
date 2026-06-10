/**
 * Plugins/SeamlessFieldFlight/Preloader.js
 *
 * Background preloader. Parses a destination map in the plugin's OWN worker
 * (PreloadWorker — stock MapLoader, fully initialised) and stashes the parsed
 * payloads into MapCache. No core/engine modification: it doesn't use the shared
 * main worker or the global Thread hooks.
 *
 * Serialised: one preload at a time (the portal-proximity trigger retries later
 * if busy). A cancelled preload still completes in the worker but its payload is
 * discarded.
 */

import DB from 'DB/DBManager.js';
import Configs from 'Core/Configs.js';
import MapCache from './MapCache.js';
import PreloadWorker from './PreloadWorker.js';

let _busy = false;
let _inflight = null;
let _cancelled = false;

function norm(name) {
	return String(name).replace(/\.(gat|rsw)$/i, '').toLowerCase();
}

const Preloader = {
	/**
	 * Warm up the plugin's worker. Call once on plugin init.
	 */
	init() {
		PreloadWorker.init();
	},

	/**
	 * Request a background preload of a map. No-op if already cached, already
	 * loading it, or another preload is running.
	 *
	 * @param {string} mapname
	 */
	preload(mapname) {
		if (!mapname || _busy) {
			return;
		}
		const name = norm(mapname);
		if (MapCache.has(name) || _inflight === name) {
			return;
		}

		_busy = true;
		_inflight = name;
		_cancelled = false;

		PreloadWorker.loadMap(name + '.rsw', (success, payload) => {
			if (
				!_cancelled &&
				success &&
				payload &&
				payload.world &&
				payload.ground &&
				payload.altitude &&
				_inflight
			) {
				payload.mapInfo = DB.getMap(_inflight + '.rsw');
				MapCache.put(_inflight, payload);
				if (Configs.get('seamlessDebug') !== false) {
					console.log('%c[SeamlessFlight] cache ✓ ' + _inflight, 'color:#9E9E9E');
				}
			}
			_busy = false;
			_inflight = null;
			_cancelled = false;
		});
	},

	/**
	 * Abandon the in-flight preload's result (e.g. on a real map change). The
	 * worker still finishes; the payload is discarded and no new preload starts
	 * until it does.
	 */
	cancel() {
		if (_busy) {
			_cancelled = true;
		}
	},

	isPreloading(mapname) {
		if (!_inflight) {
			return false;
		}
		return mapname ? _inflight === norm(mapname) : true;
	}
};

export default Preloader;
