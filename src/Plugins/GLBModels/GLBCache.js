/**
 * Plugins/GLBModels/GLBCache.js
 *
 * Caches parsed GLB models and their uploaded GPU resources.
 * Ensures each GLB file is fetched, parsed, and uploaded to GPU only once.
 *
 * Uses Client.loadFile to load files through the RemoteClient/GRF pipeline,
 * maintaining the same loading pattern as other roBrowser assets.
 *
 * Loading flow:
 *   1. Load main model from data/model/3dmob/{name}_{index}.glb
 *   2. Load each bone action from data/model/3dmob_bone/{index}_{action}.glb
 *   3. Merge bone animations into main model
 */
import Client from 'Core/Client.js';
import GLBLoader from './GLBLoader.js';

var GLBCache = {};

/**
 * @var {object} parsed model cache (filePath -> parsed data)
 */
var _parsed = {};

/**
 * @var {object} GPU resource cache (filePath -> gpu handle)
 */
var _gpu = {};

/**
 * @var {object} pending load callbacks (filePath -> callback[])
 */
var _pending = {};

/**
 * Load, parse, and cache a GLB file via Client.loadFile (RemoteClient/GRF).
 * Returns parsed data via callback. GPU upload is deferred to the renderer.
 *
 * @param {string} filePath - GRF-style path (e.g. 'data/model/3dmob/aguardian90_8.glb')
 * @param {function} callback - function(parsedData) or function(null) on error
 */
GLBCache.get = function get(filePath, callback) {
	// Already parsed
	if (_parsed[filePath]) {
		callback(_parsed[filePath]);
		return;
	}

	// Already loading - queue callback
	if (_pending[filePath]) {
		_pending[filePath].push(callback);
		return;
	}

	// Start loading
	_pending[filePath] = [callback];

	Client.loadFile(filePath,
		function onSuccess(data) {
			try {
				// Client.loadFile returns ArrayBuffer for unknown extensions (.glb)
				var buffer = data instanceof ArrayBuffer ? data : data.buffer || data;
				var parsed = GLBLoader.parse(buffer);
				_parsed[filePath] = parsed;

				// Notify all waiting callbacks
				var callbacks = _pending[filePath];
				delete _pending[filePath];
				for (var i = 0; i < callbacks.length; i++) {
					callbacks[i](parsed);
				}
			} catch (e) {
				console.error('[GLBCache] Parse error for ' + filePath + ':', e);
				_notifyError(filePath);
			}
		},
		function onError() {
			console.error('[GLBCache] Failed to load: ' + filePath);
			_notifyError(filePath);
		}
	);
};

/**
 * Load all bone action files for a model and merge them.
 *
 * Each bone file is a separate GLB: {mobIndex}_{action}.glb
 * Actions: attack, move, damage, dead
 *
 * Files that don't exist are silently skipped (not all models have all actions).
 *
 * @param {Array} boneActions - array of { action: string, path: string }
 * @param {object} mainParsed - parsed GLB data from the main model
 * @param {function} callback - function(mainParsed) when all bones are loaded/attempted
 */
GLBCache.loadAllBones = function loadAllBones(boneActions, mainParsed, callback) {
	if (!boneActions || boneActions.length === 0) {
		callback(mainParsed);
		return;
	}

	var remaining = boneActions.length;
	var mergedCount = 0;

	function onBoneDone() {
		remaining--;
		if (remaining <= 0) {
			if (mergedCount > 0) {
				console.log('[GLBCache] Merged ' + mergedCount + ' bone action(s), total animations: ' +
					mainParsed.animations.length);
			}
			callback(mainParsed);
		}
	}

	for (var i = 0; i < boneActions.length; i++) {
		_loadBoneAction(boneActions[i].path, boneActions[i].action, mainParsed, function (success) {
			if (success) mergedCount++;
			onBoneDone();
		});
	}
};

/**
 * Load a single bone action file and merge it into the main model.
 *
 * @param {string} bonePath - GRF path (e.g. 'data/model/3dmob_bone/8_attack.glb')
 * @param {string} actionName - action name ('attack', 'move', 'damage', 'dead')
 * @param {object} mainParsed - main model to merge into
 * @param {function} callback - function(success: boolean)
 */
function _loadBoneAction(bonePath, actionName, mainParsed, callback) {
	// Check if already cached
	if (_parsed[bonePath]) {
		GLBLoader.mergeBoneAction(mainParsed, _parsed[bonePath], actionName);
		callback(true);
		return;
	}

	Client.loadFile(bonePath,
		function onSuccess(data) {
			try {
				var buffer = data instanceof ArrayBuffer ? data : data.buffer || data;
				var boneParsed = GLBLoader.parse(buffer);
				_parsed[bonePath] = boneParsed;

				GLBLoader.mergeBoneAction(mainParsed, boneParsed, actionName);
				callback(true);
			} catch (e) {
				console.warn('[GLBCache] Bone parse error for ' + bonePath + ':', e);
				callback(false);
			}
		},
		function onError() {
			// Not critical - model works without this action
			callback(false);
		}
	);
}

/**
 * Notify all pending callbacks with null (error)
 */
function _notifyError(filePath) {
	var callbacks = _pending[filePath];
	delete _pending[filePath];
	if (callbacks) {
		for (var i = 0; i < callbacks.length; i++) {
			callbacks[i](null);
		}
	}
}

/**
 * Store a GPU handle for a file path
 *
 * @param {string} filePath
 * @param {object} gpuHandle
 */
GLBCache.setGPU = function setGPU(filePath, gpuHandle) {
	_gpu[filePath] = gpuHandle;
};

/**
 * Get cached GPU handle
 *
 * @param {string} filePath
 * @returns {object|null}
 */
GLBCache.getGPU = function getGPU(filePath) {
	return _gpu[filePath] || null;
};

/**
 * Free all cached resources
 *
 * @param {WebGLRenderingContext} gl
 * @param {function} freeGPUFn - function(gl, gpuHandle) to release GPU resources
 */
GLBCache.free = function free(gl, freeGPUFn) {
	if (freeGPUFn) {
		for (var key in _gpu) {
			if (_gpu.hasOwnProperty(key)) {
				freeGPUFn(gl, _gpu[key]);
			}
		}
	}
	_parsed = {};
	_gpu = {};
	_pending = {};
};

export default GLBCache;
