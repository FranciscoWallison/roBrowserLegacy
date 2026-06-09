/**
 * Plugins/SeamlessFieldFlight/MapCache.js
 *
 * In-memory LRU cache of parsed worker MAP_* payloads, used to swap an already
 * preloaded neighbour field in without a loading screen.
 *
 * Stores ONLY the parsed payloads the worker posts (world, ground, altitude,
 * models, animatedModels) plus the resolved mapInfo — never live GL buffers.
 * Those payloads are exactly what the engine's onXComplete handlers consume, so
 * a swap can replay them through the existing GL init paths.
 *
 * Pure storage: Preloader fills it, Swap drains it.
 */

/** How many neighbour payloads to keep resident (besides the live map). */
let _maxEntries = 1;

/** key (bare lowercase map name) -> { payload, urls }; Map order = LRU. */
const _entries = new Map();

function norm(name) {
	return String(name).replace(/\.(gat|rsw)$/i, '').toLowerCase();
}

/**
 * Collect blob: object-URL strings from a payload so they can be revoked when
 * the entry is dropped without being uploaded to the GPU. Path strings are
 * ignored.
 *
 * @param {object} payload
 * @return {string[]}
 */
function collectBlobUrls(payload) {
	const urls = [];
	const push = value => {
		if (typeof value === 'string') {
			if (value.lastIndexOf('blob:', 0) === 0) {
				urls.push(value);
			}
		} else if (Array.isArray(value)) {
			value.forEach(push);
		}
	};

	if (payload) {
		if (payload.ground) {
			push(payload.ground.textures);
		}
		if (payload.world && payload.world.water) {
			push(payload.world.water.images);
		}
		if (payload.models && Array.isArray(payload.models.infos)) {
			payload.models.infos.forEach(info => info && push(info.texture));
		}
	}

	return urls;
}

function revokeEntry(entry) {
	if (!entry || !entry.urls) {
		return;
	}
	for (let i = 0; i < entry.urls.length; ++i) {
		try {
			URL.revokeObjectURL(entry.urls[i]);
		} catch (e) {
			/* best-effort */
		}
	}
	entry.urls.length = 0;
}

function evictToLimit() {
	while (_entries.size > _maxEntries) {
		const oldestKey = _entries.keys().next().value;
		const entry = _entries.get(oldestKey);
		_entries.delete(oldestKey);
		revokeEntry(entry);
	}
}

const MapCache = {
	setMaxEntries(n) {
		_maxEntries = Math.max(0, n | 0);
		evictToLimit();
	},

	getMaxEntries() {
		return _maxEntries;
	},

	has(name) {
		return _entries.has(norm(name));
	},

	/** Fetch a cached payload and mark it MRU. Does NOT remove it. */
	get(name) {
		const key = norm(name);
		const entry = _entries.get(key);
		if (!entry) {
			return null;
		}
		_entries.delete(key);
		_entries.set(key, entry);
		return entry.payload;
	},

	/** Remove a cached payload (used when swapping it in). URLs NOT revoked. */
	take(name) {
		const key = norm(name);
		const entry = _entries.get(key);
		if (!entry) {
			return null;
		}
		_entries.delete(key);
		return entry.payload;
	},

	put(name, payload) {
		const key = norm(name);
		const existing = _entries.get(key);
		if (existing) {
			revokeEntry(existing);
			_entries.delete(key);
		}
		_entries.set(key, { payload: payload, urls: collectBlobUrls(payload) });
		evictToLimit();
	},

	evict(name) {
		const key = norm(name);
		const entry = _entries.get(key);
		if (entry) {
			_entries.delete(key);
			revokeEntry(entry);
		}
	},

	clear() {
		_entries.forEach(revokeEntry);
		_entries.clear();
	},

	keys() {
		return Array.from(_entries.keys());
	}
};

export default MapCache;
