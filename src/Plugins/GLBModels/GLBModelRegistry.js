/**
 * Plugins/GLBModels/GLBModelRegistry.js
 *
 * Configuration registry mapping entity job/mob IDs to GLB model files.
 * Models are loaded via Client.loadFile from the GRF/RemoteClient system.
 *
 * File naming convention (from original .gr2 system):
 *   Model:     data/model/3dmob/{name}_{mobIndex}.glb
 *   Bones:     data/model/3dmob_bone/{mobIndex}_{action}.glb
 *
 * The mob index is the numeric suffix of the model filename and acts as
 * the link between model and its bone animation files.
 *
 * Available bone actions: attack, move, damage, dead
 *
 * Usage in Config.local.js:
 *   models: {
 *       1288: { file: 'empelium90_0.glb', mobIndex: 0, scale: 0.2 },
 *       1285: { file: 'aguardian90_8.glb', mobIndex: 8, scale: 0.18 },
 *       1287: { file: 'kguardian90_7.glb', mobIndex: 7, scale: 0.20 }
 *   }
 */
var GLBModelRegistry = {};

/**
 * @var {object} map of jobId/mobId -> model config
 */
var _models = {};

/**
 * @var {string} base path for 3D model files (with embedded idle animation)
 */
var _modelPath = 'data/model/3dmob/';

/**
 * @var {string} base path for bone animation files
 */
var _bonePath = 'data/model/3dmob_bone/';

/**
 * @var {Array} known bone action types
 */
var BONE_ACTIONS = ['attack', 'move', 'damage', 'dead'];

/**
 * Initialize registry from plugin parameters
 *
 * @param {object} params - plugin parameters from Config
 */
GLBModelRegistry.init = function init(params) {
	if (params && params.modelPath) {
		_modelPath = params.modelPath;
		if (_modelPath.charAt(_modelPath.length - 1) !== '/') {
			_modelPath += '/';
		}
	}
	if (params && params.bonePath) {
		_bonePath = params.bonePath;
		if (_bonePath.charAt(_bonePath.length - 1) !== '/') {
			_bonePath += '/';
		}
	}
	if (params && params.models) {
		for (var id in params.models) {
			if (params.models.hasOwnProperty(id)) {
				var cfg = params.models[id];
				// Auto-extract mobIndex from filename if not specified
				if (cfg.mobIndex === undefined) {
					cfg.mobIndex = this._extractMobIndex(cfg.file);
				}
				_models[id] = cfg;
			}
		}
	}
};

/**
 * Extract mob index from model filename.
 * Pattern: {name}_{index}.glb -> index
 * Example: 'aguardian90_8.glb' -> 8
 *
 * @param {string} filename
 * @returns {number} mob index, or -1 if not found
 */
GLBModelRegistry._extractMobIndex = function _extractMobIndex(filename) {
	// Remove extension
	var base = filename.replace(/\.glb$/i, '');
	// Get the part after the last underscore
	var lastUnderscore = base.lastIndexOf('_');
	if (lastUnderscore >= 0) {
		var suffix = base.substring(lastUnderscore + 1);
		var num = parseInt(suffix, 10);
		if (!isNaN(num)) {
			return num;
		}
	}
	return -1;
};

/**
 * Register a model mapping at runtime
 *
 * @param {number} jobOrMobId
 * @param {object} config - { file: string, mobIndex?: number, scale?: number, actions?: string[] }
 */
GLBModelRegistry.register = function register(jobOrMobId, config) {
	if (config.mobIndex === undefined) {
		config.mobIndex = this._extractMobIndex(config.file);
	}
	_models[jobOrMobId] = config;
};

/**
 * Check if an entity job/mob ID has a GLB model registered
 *
 * @param {number} jobOrMobId
 * @returns {boolean}
 */
GLBModelRegistry.hasModel = function hasModel(jobOrMobId) {
	return jobOrMobId in _models;
};

/**
 * Get model configuration for a job/mob ID
 *
 * @param {number} jobOrMobId
 * @returns {object|null} config or null
 */
GLBModelRegistry.getModel = function getModel(jobOrMobId) {
	return _models[jobOrMobId] || null;
};

/**
 * Get full model file path for a config
 *
 * @param {object} config - model config with 'file' property
 * @returns {string} full path (e.g. 'data/model/3dmob/aguardian90_8.glb')
 */
GLBModelRegistry.getModelPath = function getModelPath(config) {
	return _modelPath + config.file;
};

/**
 * Get the list of bone action file paths to try loading.
 * Each bone file: {bonePath}/{mobIndex}_{action}.glb
 *
 * If config.actions is specified, only those actions are used.
 * Otherwise tries all known actions: attack, move, damage, dead
 *
 * @param {object} config - model config with 'mobIndex'
 * @returns {Array} array of { action: string, path: string }
 */
GLBModelRegistry.getBoneActionPaths = function getBoneActionPaths(config) {
	if (config.mobIndex < 0) {
		return [];
	}

	var actions = config.actions || BONE_ACTIONS;
	var result = [];

	for (var i = 0; i < actions.length; i++) {
		result.push({
			action: actions[i],
			path: _bonePath + config.mobIndex + '_' + actions[i] + '.glb'
		});
	}

	return result;
};

/**
 * Get base model path
 *
 * @returns {string}
 */
GLBModelRegistry.getBasePath = function getBasePath() {
	return _modelPath;
};

/**
 * Get the list of all known bone action types
 *
 * @returns {Array}
 */
GLBModelRegistry.getBoneActions = function getBoneActions() {
	return BONE_ACTIONS;
};

export default GLBModelRegistry;
