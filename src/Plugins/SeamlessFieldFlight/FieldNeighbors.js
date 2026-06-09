/**
 * Plugins/SeamlessFieldFlight/FieldNeighbors.js
 *
 * Policy layer over the generated field-adjacency table. Decides whether a map
 * transition is eligible for a seamless (no loading screen) swap and exposes the
 * neighbour list that drives background preloading.
 *
 * Self-contained: reads the bundled FieldAdjacency table directly (no core DB
 * dependency).
 */

import FieldAdjacency from './FieldAdjacency.js';
import Configs from 'Core/Configs.js';

function norm(name) {
	return String(name || '').replace(/\.(gat|rsw)$/i, '').toLowerCase();
}

const FieldNeighbors = {
	/**
	 * Seamless field flight enabled? Defaults to ON; disable with
	 * `Configs.set('enableSeamlessFlight', false)`.
	 *
	 * @return {boolean}
	 */
	isEnabled() {
		return Configs.get('enableSeamlessFlight') !== false;
	},

	/**
	 * Adjacency record for a field map.
	 *
	 * @param {string} mapname
	 * @return {object|null} { neighbors: [{ dir, map, dst, edge, offset, warps }] }
	 */
	getNeighbors(mapname) {
		return FieldAdjacency[norm(mapname)] || null;
	},

	/**
	 * Neighbouring field map names of a map.
	 *
	 * @param {string} mapname
	 * @return {string[]}
	 */
	getNeighborMaps(mapname) {
		const record = this.getNeighbors(mapname);
		return record && record.neighbors ? record.neighbors.map(n => n.map) : [];
	},

	/**
	 * Whether transitioning from `fromMap` to `toMap` can be a seamless swap:
	 * the feature is enabled and `toMap` is a known field neighbour of `fromMap`.
	 *
	 * @param {string} fromMap
	 * @param {string} toMap
	 * @return {boolean}
	 */
	isSeamlessEligible(fromMap, toMap) {
		if (!this.isEnabled() || !fromMap || !toMap) {
			return false;
		}
		const record = this.getNeighbors(fromMap);
		if (!record || !record.neighbors) {
			return false;
		}
		const target = norm(toMap);
		return record.neighbors.some(n => n.map === target);
	}
};

export default FieldNeighbors;
