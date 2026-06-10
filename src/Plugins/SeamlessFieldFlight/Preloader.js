/**
 * Plugins/SeamlessFieldFlight/Preloader.js
 *
 * Background preloader. Loads a neighbour field map on the MAIN worker via the
 * dedicated PRELOAD_MAP command (which emits *_PRELOAD message types so it never
 * collides with the live map's MAP_* hooks) and stashes the parsed payloads into
 * MapCache.
 *
 * A fresh/dedicated worker cannot be used here: FileManager in a new worker is
 * uninitialised (it needs the main worker's CLIENT_INIT), so preloading reuses
 * the already-initialised main worker.
 *
 * Serialised: one preload at a time, and a new one cannot start until the
 * running worker load completes. Because the worker's completion echo arrives
 * after all of its data messages (postMessage ordering), a cancelled preload's
 * late *_PRELOAD messages can never pollute the next preload's payload.
 */

import Thread from 'Core/Thread.js';
import DB from 'DB/DBManager.js';
import Configs from 'Core/Configs.js';
import MapCache from './MapCache.js';

const PRELOAD_TYPES = [
	'MAP_WORLD_PRELOAD',
	'MAP_GROUND_PRELOAD',
	'MAP_ALTITUDE_PRELOAD',
	'MAP_MODELS_PRELOAD',
	'MAP_ANIMATED_MODEL_PRELOAD'
];

let _busy = false;
let _inflight = null;
let _payload = null;
let _cancelled = false;
let _installed = false;

function norm(name) {
	return String(name).replace(/\.(gat|rsw)$/i, '').toLowerCase();
}

/**
 * Install the *_PRELOAD accumulation hooks once. They always write into the
 * current `_payload`; a cancelled preload's payload is discarded on completion.
 */
function install() {
	if (_installed) {
		return;
	}
	_installed = true;

	Thread.hook('MAP_WORLD_PRELOAD', data => {
		if (_payload) {
			_payload.world = data;
		}
	});
	Thread.hook('MAP_GROUND_PRELOAD', data => {
		if (_payload) {
			_payload.ground = data;
		}
	});
	Thread.hook('MAP_ALTITUDE_PRELOAD', data => {
		if (_payload) {
			_payload.altitude = data;
		}
	});
	Thread.hook('MAP_MODELS_PRELOAD', data => {
		if (_payload) {
			_payload.models = data;
		}
	});
	Thread.hook('MAP_ANIMATED_MODEL_PRELOAD', data => {
		if (_payload) {
			(_payload.animatedModels || (_payload.animatedModels = [])).push(data);
		}
	});
}

const Preloader = {
	/**
	 * Install the worker hooks. Call once on plugin init.
	 */
	init() {
		install();
	},

	/**
	 * Request a background preload of a neighbour field map. No-op if already
	 * cached, already loading it, or another preload is running.
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

		install();
		_busy = true;
		_inflight = name;
		_payload = {};
		_cancelled = false;

		Thread.send('PRELOAD_MAP', name + '.rsw', success => {
			if (!_cancelled && success && _payload && _inflight) {
				_payload.mapInfo = DB.getMap(_inflight + '.rsw');
				MapCache.put(_inflight, _payload);
				if (Configs.get('seamlessDebug') !== false) {
					console.log('%c[SeamlessFlight] cache ✓ ' + _inflight, 'color:#9E9E9E');
				}
			}
			_busy = false;
			_inflight = null;
			_payload = null;
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
