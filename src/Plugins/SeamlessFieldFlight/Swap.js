/**
 * Plugins/SeamlessFieldFlight/Swap.js
 *
 * Performs the instant, fade-masked map swap. Instead of reimplementing the
 * engine's private onXComplete map-build logic, it CAPTURES the real handlers
 * the engine registers via Thread.hook (onWorldComplete, onGroundComplete, ...)
 * and replays them with the cached payloads. This guarantees the swap builds the
 * map exactly like a normal load, with zero duplicated GL code.
 *
 * The render loop, post-processing pipeline and UI are left running; only the
 * per-map GL resources are freed and rebuilt, under a short black fade.
 */

import jQuery from 'Utils/jquery.js';
import Renderer from 'Renderer/Renderer.js';
import MapRenderer from 'Renderer/MapRenderer.js';
import EntityManager from 'Renderer/EntityManager.js';
import GridSelector from 'Renderer/Map/GridSelector.js';
import Ground from 'Renderer/Map/Ground.js';
import Water from 'Renderer/Map/Water.js';
import Models from 'Renderer/Map/Models.js';
import AnimatedModels from 'Renderer/Map/AnimatedModels.js';
import Sounds from 'Renderer/Map/Sounds.js';
import Effects from 'Renderer/Map/Effects.js';
import Damage from 'Renderer/Effects/Damage.js';
import EffectManager from 'Renderer/EffectManager.js';
import SignboardManager from 'Renderer/SignboardManager.js';
import ScreenEffectManager from 'Renderer/ScreenEffectManager.js';
import Sky from 'Renderer/Effects/Sky.js';
import SoundManager from 'Audio/SoundManager.js';
import BGM from 'Audio/BGM.js';
import Mouse from 'Controls/MouseEventHandler.js';
import DB from 'DB/DBManager.js';
import Configs from 'Core/Configs.js';

import MapCache from './MapCache.js';
import Preloader from './Preloader.js';

/** Half-transition fade duration (ms); configurable, default 200. */
function fadeDuration() {
	const v = Configs.get('seamlessFadeDuration');
	return typeof v === 'number' && v >= 0 ? v : 200;
}

/** Live worker-completion handlers, captured from Thread.hook. */
const captured = {};

/** Worker message types whose handlers rebuild the map. */
const LIVE_TYPES = ['MAP_WORLD', 'MAP_GROUND', 'MAP_ALTITUDE', 'MAP_MODELS', 'MAP_ANIMATED_MODEL'];

/** Fade overlay (own element, above the game canvas and UI). */
const _overlay = jQuery('<div/>').css({
	position: 'absolute',
	top: 0,
	left: 0,
	width: '100%',
	height: '100%',
	backgroundColor: 'black',
	opacity: 0,
	zIndex: 1001,
	pointerEvents: 'none'
});

function norm(name) {
	return String(name).replace(/\.(gat|rsw)$/i, '').toLowerCase();
}

/**
 * Briefly fade to black, run `midCallback` while fully opaque, then fade back.
 *
 * @param {function} midCallback
 * @param {number} duration  half-transition duration (ms)
 */
function fadeMask(midCallback, duration) {
	const d = duration || 200;
	_overlay
		.stop()
		.css('opacity', 0.01)
		.appendTo('body')
		.animate({ opacity: 1.0 }, d, () => {
			try {
				midCallback();
			} catch (e) {
				console.error('[SeamlessFieldFlight] swap failed:', e);
			}
			_overlay.stop().animate({ opacity: 0.01 }, d, () => _overlay.remove());
		});
}

const Swap = {
	/**
	 * Record a live map-build handler (called from the plugin's Thread.hook wrap).
	 *
	 * @param {string} type
	 * @param {function} cb
	 */
	captureHandler(type, cb) {
		if (cb && LIVE_TYPES.indexOf(type) !== -1) {
			captured[type] = cb;
		}
	},

	/**
	 * @return {boolean} whether the essential map-build handlers are captured
	 */
	hasHandlers() {
		return !!(captured.MAP_WORLD && captured.MAP_GROUND && captured.MAP_ALTITUDE);
	},

	/**
	 * Swap an already-preloaded adjacent field map in with no loading screen.
	 *
	 * @param {string} mapname  normalized (no extension) target map
	 * @return {boolean} true if the swap was performed
	 */
	performSwap(mapname) {
		if (!this.hasHandlers()) {
			return false;
		}

		const key = norm(mapname);
		const payload = MapCache.take(key);
		if (!payload || !payload.world || !payload.ground || !payload.altitude) {
			return false;
		}

		// Guard against a re-entrant setMap during the fade.
		MapRenderer.loading = true;
		MapRenderer.currentMap = mapname;
		Mouse.intersect = false;

		const worldResource = mapname.replace(/\.gat$/i, '.rsw');

		fadeMask(() => {
			const gl = Renderer.getContext();

			// Release the previous map's per-map GL + lists. Keep the renderer,
			// post-processing and global sprite renderer alive.
			EntityManager.free();
			GridSelector.free(gl);
			Sounds.free();
			Effects.free();
			Ground.free(gl);
			Water.free(gl);
			Models.free(gl);
			AnimatedModels.free(gl);
			Damage.free(gl);
			EffectManager.free(gl);
			SignboardManager.free();
			SoundManager.stop();

			// Rebuild the new map by replaying the cached payloads through the
			// engine's own (captured) handlers — same order as a normal load.
			captured.MAP_WORLD(payload.world);
			captured.MAP_ALTITUDE(payload.altitude);
			captured.MAP_GROUND(payload.ground);
			if (payload.models && captured.MAP_MODELS) {
				captured.MAP_MODELS(payload.models);
			}
			if (payload.animatedModels && captured.MAP_ANIMATED_MODEL) {
				for (let i = 0; i < payload.animatedModels.length; ++i) {
					captured.MAP_ANIMATED_MODEL(payload.animatedModels[i]);
				}
			}

			// Re-init the per-map effect renderers we freed + map-dependent ones.
			Damage.init(gl);
			EffectManager.init(gl);
			Sky.init(gl, worldResource);
			ScreenEffectManager.init(gl, worldResource);

			// Fog + BGM from the map info.
			const mapInfo = payload.mapInfo || DB.getMap(worldResource);
			BGM.play((mapInfo && mapInfo.mp3) || '01.mp3');
			MapRenderer.fog.exist = !!(mapInfo && mapInfo.fog);
			if (MapRenderer.fog.exist) {
				MapRenderer.fog.near = mapInfo.fog.near * 240;
				MapRenderer.fog.far = mapInfo.fog.far * 240;
				MapRenderer.fog.factor = mapInfo.fog.factor;
				MapRenderer.fog.color.set(mapInfo.fog.color);
			}

			// Finalize. MapRenderer.onLoad is the closure MapEngine.onMapChange
			// just set (with the server's drop coordinates); running it places the
			// player, signboards, camera and sends CZ_NOTIFY_ACTORINIT. The UI is
			// still appended, so its append() calls just re-attach (no duplicates).
			MapRenderer.loading = false;
			Mouse.intersect = true;
			if (typeof MapRenderer.onLoad === 'function') {
				MapRenderer.onLoad();
			}
			Sky.setUpCloudData();
			ScreenEffectManager.startMapflagEffect(worldResource);

			// Drop any stale in-flight preload; the next neighbour is preloaded
			// on edge approach by the edge trigger.
			Preloader.cancel();
		}, fadeDuration());

		return true;
	}
};

export default Swap;
