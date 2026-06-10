/**
 * Plugins/SeamlessFieldFlight/PreloadWorker.js
 *
 * A plugin-owned, fully-initialised Web Worker that runs the STOCK
 * ThreadEventHandler + MapLoader to parse a map off the main thread, with its
 * own private message listener (so it never touches the global Thread hooks or
 * the live map's pipeline).
 *
 * It is initialised by replaying the messages the main worker receives
 * (SET_HOST + CLIENT_FILES_ALIAS + CLIENT_INIT). CLIENT_INIT is the key piece:
 * it initialises FileSystem in the worker (`_fs.root`), without which
 * FileManager.get throws "Cannot read properties of undefined (reading 'root')".
 *
 * This is what makes the seamless feature 100% plugin (no core edit): it reuses
 * the stock LOAD_MAP / MapLoader, so the parsed payloads are byte-for-byte the
 * same as a normal load — zero quality difference.
 *
 * In remote-client mode (FileManager.init finds no local GRF) the init is cheap
 * and files are fetched over HTTP.
 */

import Configs from 'Core/Configs.js';
import DB from 'DB/DBManager.js';

let _worker = null;
let _ready = false;
let _initUid = 0;
let _uid = 1;
let _readyWaiters = [];
let _active = null; // { uid, payload, onload }

/**
 * Query temporary-storage quota (mirrors Core/Client.js); best-effort.
 *
 * @param {function} cb  ({used, remaining}) => void
 */
function queryQuota(cb) {
	try {
		const ts = navigator.webkitTemporaryStorage || navigator.temporaryStorage;
		if (ts && ts.queryUsageAndQuota) {
			ts.queryUsageAndQuota(
				(used, remaining) => cb({ used: used, remaining: remaining }),
				() => cb({ used: 0, remaining: 0 })
			);
			return;
		}
	} catch (e) {
		/* ignore */
	}
	cb({ used: 0, remaining: 0 });
}

/**
 * Private message handler for the plugin's worker.
 */
function onMessage(event) {
	const msg = event.data;
	if (!msg) {
		return;
	}

	// uid-tagged completion (CLIENT_INIT or LOAD_MAP).
	if (msg.uid) {
		if (msg.uid === _initUid) {
			_ready = true;
			const waiters = _readyWaiters;
			_readyWaiters = [];
			for (let i = 0; i < waiters.length; ++i) {
				waiters[i]();
			}
			return;
		}
		if (_active && msg.uid === _active.uid) {
			const active = _active;
			_active = null;
			const success = !!(msg.arguments && msg.arguments[0]);
			const error = msg.arguments && msg.arguments[1];
			if (active.onload) {
				active.onload(success, active.payload, error);
			}
		}
		return;
	}

	// Untagged data messages belong to the in-flight LOAD_MAP (serialised).
	if (!_active) {
		return;
	}
	const p = _active.payload;
	switch (msg.type) {
		case 'MAP_WORLD':
			p.world = msg.data;
			break;
		case 'MAP_GROUND':
			p.ground = msg.data;
			break;
		case 'MAP_ALTITUDE':
			p.altitude = msg.data;
			break;
		case 'MAP_MODELS':
			p.models = msg.data;
			break;
		case 'MAP_ANIMATED_MODEL':
			(p.animatedModels || (p.animatedModels = [])).push(msg.data);
			break;
		default:
			break; // MAP_PROGRESS / THREAD_READY / CLIENT_SAVE_* / logs ignored
	}
}

/**
 * Spawn + initialise the worker (idempotent).
 */
function ensureWorker() {
	if (_worker) {
		return;
	}

	_worker = new Worker(new URL('../../Core/ThreadEventHandler.js', import.meta.url), { type: 'module' });
	_worker.addEventListener('message', onMessage);
	_worker.addEventListener('error', e => {
		console.error('[SeamlessFlight] preload worker error:', e.message || e);
	});

	// 1. Host for HTTP file fetches.
	const remoteClient = Configs.get('remoteClient');
	if (remoteClient) {
		_worker.postMessage({ type: 'SET_HOST', data: remoteClient });
	}

	// 2. Map-instance aliases (parity with the main worker).
	try {
		if (DB.mapalias) {
			_worker.postMessage({ type: 'CLIENT_FILES_ALIAS', data: DB.mapalias });
		}
	} catch (e) {
		/* ignore */
	}

	// 3. CLIENT_INIT -> initialises FileSystem (the missing piece). Wait for it.
	_initUid = _uid++;
	queryQuota(quota => {
		if (!_worker) {
			return;
		}
		_worker.postMessage({
			type: 'CLIENT_INIT',
			uid: _initUid,
			data: {
				files: [],
				grfList: Configs.get('grfList') || 'DATA.INI',
				save: false,
				quota: quota
			}
		});
	});
}

const PreloadWorker = {
	/**
	 * Spawn + initialise the worker (idempotent). Safe to call early to warm up.
	 */
	init() {
		ensureWorker();
	},

	/** @return {boolean} */
	isReady() {
		return _ready;
	},

	/**
	 * Run `cb` once the worker is initialised.
	 *
	 * @param {function} cb
	 */
	whenReady(cb) {
		ensureWorker();
		if (_ready) {
			cb();
		} else {
			_readyWaiters.push(cb);
		}
	},

	/**
	 * Parse a map in the worker and return the assembled payload. Serialised by
	 * the caller (one in flight at a time).
	 *
	 * @param {string} rswName  e.g. "prt_fild07.rsw"
	 * @param {function} onload  (success, payload, error) => void
	 */
	loadMap(rswName, onload) {
		this.whenReady(() => {
			const uid = _uid++;
			_active = { uid: uid, payload: {}, onload: onload };
			_worker.postMessage({ type: 'LOAD_MAP', data: rswName, uid: uid });
		});
	}
};

export default PreloadWorker;
