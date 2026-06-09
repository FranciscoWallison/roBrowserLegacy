/**
 * Plugins/GLBModels/GLBAnimationMapper.js
 *
 * Maps RO entity action constants to GLB animation clip names.
 *
 * Bone action files use these names (from filename convention):
 *   attack  - {mobIndex}_attack.glb
 *   move    - {mobIndex}_move.glb
 *   damage  - {mobIndex}_damage.glb
 *   dead    - {mobIndex}_dead.glb
 *
 * The main model's embedded animation (idle/breath) is the first animation
 * in the model and is used as the default/fallback.
 */
var GLBAnimationMapper = {};

/**
 * Mapping from RO action names to bone action clip names.
 * Each RO action maps to a list of candidate names (tried in order).
 *
 * The bone file names are: attack, move, damage, dead
 * The embedded animation is typically named by the exporter (varies).
 */
var _defaultMap = {
	// Idle uses the embedded animation (first in the model) as fallback
	IDLE: ['idle', 'stand', 'rest', 'breath'],

	// Movement
	WALK: ['move', 'walk', 'run'],

	// Combat
	ATTACK:  ['attack', 'attack1'],
	ATTACK1: ['attack', 'attack1'],
	ATTACK2: ['attack', 'attack2'],
	ATTACK3: ['attack', 'attack3'],

	// Damage / Death
	HURT: ['damage', 'hurt', 'hit'],
	DIE:  ['dead', 'die', 'death'],

	// Other actions (fallback to related bone actions)
	SIT:        ['sit', 'idle'],
	PICKUP:     ['pickup', 'idle'],
	READYFIGHT: ['attack', 'idle'],
	SKILL:      ['attack', 'skill', 'cast'],
	FREEZE:     ['damage', 'idle'],
	STANDBY:    ['idle', 'stand']
};

/**
 * Find the best matching GLB animation clip for an entity's current action.
 *
 * Search order:
 *   1. Custom animMap from config (if provided)
 *   2. Default mapping (bone action names: attack, move, damage, dead)
 *   3. Partial name match
 *   4. First animation in model (embedded idle)
 *
 * @param {Entity} entity - roBrowser entity
 * @param {object} parsedGLB - parsed GLB data with animations[]
 * @param {object} customMap - per-model animation name overrides (optional)
 * @returns {object|null} animation clip object or null
 */
GLBAnimationMapper.getClip = function getClip(entity, parsedGLB, customMap) {
	if (!parsedGLB.animations || parsedGLB.animations.length === 0) {
		return null;
	}

	var actionName = this._resolveActionName(entity);
	var candidates = (customMap && customMap[actionName]) || _defaultMap[actionName] || _defaultMap.IDLE;

	var result = null;
	var matchType = '';

	// Search GLB animations for a matching name (case-insensitive)
	for (var i = 0; !result && i < candidates.length; i++) {
		var candidateLower = candidates[i].toLowerCase();
		for (var a = 0; a < parsedGLB.animations.length; a++) {
			if (parsedGLB.animations[a].name.toLowerCase() === candidateLower) {
				result = parsedGLB.animations[a];
				matchType = 'exact';
				break;
			}
		}
	}

	// Partial match: check if any animation name contains a candidate
	if (!result) {
		for (var i2 = 0; !result && i2 < candidates.length; i2++) {
			var candidateLower2 = candidates[i2].toLowerCase();
			for (var a2 = 0; a2 < parsedGLB.animations.length; a2++) {
				if (parsedGLB.animations[a2].name.toLowerCase().indexOf(candidateLower2) !== -1) {
					result = parsedGLB.animations[a2];
					matchType = 'partial';
					break;
				}
			}
		}
	}

	// Fallback: return first animation (embedded idle from main model)
	if (!result) {
		result = parsedGLB.animations[0];
		matchType = 'fallback';
	}

	// Log clip selection when it changes (per entity)
	if (entity._lastGLBClipName !== result.name || entity._lastGLBAction !== actionName) {
		entity._lastGLBClipName = result.name;
		entity._lastGLBAction = actionName;
		console.log('[GLBAnimMapper] Action=' + actionName + ' → clip="' + result.name +
			'" (' + matchType + ', dur=' + result.duration.toFixed(2) + 's)' +
			' [available: ' + parsedGLB.animations.map(function (a) { return a.name; }).join(', ') + ']');
	}

	return result;
};

/**
 * Resolve entity's current action number to an action name string.
 *
 * @param {Entity} entity
 * @returns {string} action name (e.g., 'IDLE', 'WALK', 'ATTACK')
 */
GLBAnimationMapper._resolveActionName = function _resolveActionName(entity) {
	var ACTION = entity.ACTION;
	if (!ACTION) return 'IDLE';

	var action = entity.action;
	for (var key in ACTION) {
		if (ACTION.hasOwnProperty(key) && ACTION[key] === action) {
			return key;
		}
	}
	return 'IDLE';
};

export default GLBAnimationMapper;
