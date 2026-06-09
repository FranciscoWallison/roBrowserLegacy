/**
 * Plugins/SeamlessFieldFlight/PortalGraph.js
 *
 * Policy layer over the generated full warp graph. Provides the warp tiles of a
 * map (to preload the destination the player is walking toward) and checks
 * whether a transition target is a legitimate warp destination of the current
 * map (so the seamless swap only fires for real portal crossings).
 *
 * Covers ALL static walk-into portals, not just field borders.
 */

import WarpGraph from './WarpGraph.js';
import Configs from 'Core/Configs.js';

function norm(name) {
	return String(name || '').replace(/\.(gat|rsw)$/i, '').toLowerCase();
}

const PortalGraph = {
	/**
	 * Seamless transitions enabled? Defaults to ON; disable with
	 * `Configs.set('enableSeamlessFlight', false)`.
	 *
	 * @return {boolean}
	 */
	isEnabled() {
		return Configs.get('enableSeamlessFlight') !== false;
	},

	/**
	 * Warp tiles on a map.
	 *
	 * @param {string} mapname
	 * @return {Array<[number, number, string, number, number]>} [x, y, dstMap, toX, toY]
	 */
	getWarps(mapname) {
		return WarpGraph[norm(mapname)] || null;
	},

	/**
	 * Whether `toMap` is a warp destination reachable from `fromMap`.
	 *
	 * @param {string} fromMap
	 * @param {string} toMap
	 * @return {boolean}
	 */
	isWarpDest(fromMap, toMap) {
		if (!fromMap || !toMap) {
			return false;
		}
		const warps = WarpGraph[norm(fromMap)];
		if (!warps) {
			return false;
		}
		const target = norm(toMap);
		for (let i = 0; i < warps.length; ++i) {
			if (warps[i][2] === target) {
				return true;
			}
		}
		return false;
	},

	/**
	 * Whether transitioning from `fromMap` to `toMap` is eligible for a seamless
	 * swap: the feature is enabled and `toMap` is a warp destination of `fromMap`.
	 *
	 * @param {string} fromMap
	 * @param {string} toMap
	 * @return {boolean}
	 */
	isSeamlessEligible(fromMap, toMap) {
		return this.isEnabled() && this.isWarpDest(fromMap, toMap);
	}
};

export default PortalGraph;
