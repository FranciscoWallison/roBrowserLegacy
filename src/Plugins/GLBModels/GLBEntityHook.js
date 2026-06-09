/**
 * Plugins/GLBModels/GLBEntityHook.js
 *
 * Monkey-patches the entity rendering pipeline to support GLB 3D models.
 *
 * CRITICAL: All hooks are wrapped in try-catch to NEVER break the original
 * rendering pipeline. A crash here would cause a black screen.
 */
import Entity from 'Renderer/Entity/Entity.js';
import EntityManager from 'Renderer/EntityManager.js';
import MapRenderer from 'Renderer/MapRenderer.js';
import Renderer from 'Renderer/Renderer.js';

import GLBModelRegistry from './GLBModelRegistry.js';
import GLBCache from './GLBCache.js';
import GLBRenderer from './GLBRenderer.js';
import GLBSkinning from './GLBSkinning.js';
import GLBAnimationMapper from './GLBAnimationMapper.js';

var GLBEntityHook = {};

/**
 * @var {Array} entities currently using GLB rendering
 */
var _glbEntities = [];

/**
 * @var {boolean} one-time diagnostic flag
 */
var _firstRenderLogged = false;

/**
 * @var {boolean} guard against multiple installations
 */
var _installed = false;

/**
 * Install all hooks into the entity pipeline
 */
GLBEntityHook.install = function install() {
	if (_installed) {
		console.warn('[GLBEntityHook] Already installed, skipping duplicate install');
		return;
	}
	_installed = true;
	this._hookEntitySet();
	this._hookEntityManager();
	console.log('%c[GLBEntityHook] Hooks installed', 'color: #4CAF50');
};

/**
 * Hook 1: Intercept Entity.prototype.set to detect GLB entities.
 */
GLBEntityHook._hookEntitySet = function _hookEntitySet() {
	var _originalSet = Entity.prototype.set;
	var self = this;

	Entity.prototype.set = function (unit) {
		var prevJob = this._job;

		// ALWAYS run original set first
		_originalSet.call(this, unit);

		// Then try to detect GLB entity (safe - never breaks original)
		try {
			var jobId = this._job;
			if (jobId >= 0 && GLBModelRegistry.hasModel(jobId)) {
				if (!this._useGLB || prevJob !== jobId) {
					self._initGLBEntity(this, jobId);
				}
			} else if (this._useGLB) {
				self._removeGLBEntity(this);
			}
		} catch (e) {
			console.error('[GLBEntityHook] Error in set hook:', e);
		}
	};

	// Hook Entity.prototype.clean to immediately remove GLB entities.
	// roBrowser calls clean() on vanish, and clean() scrambles GID
	// (GID += Math.random()) and resets remove_tick = 0, making it
	// impossible to detect stale entities by GID or remove_tick later.
	var _originalClean = Entity.prototype.clean;

	Entity.prototype.clean = function () {
		if (this._useGLB) {
			this._useGLB = false;
			this._glbReady = false;
			this._glbStaticJoints = null;
			_removeFromList(this);
		}
		_originalClean.call(this);
	};
};

/**
 * Initialize an entity for GLB rendering.
 */
GLBEntityHook._initGLBEntity = function _initGLBEntity(entity, jobId) {
	var config = GLBModelRegistry.getModel(jobId);
	if (!config) return;

	entity._useGLB = true;
	entity._glbConfig = config;
	entity._glbReady = false;
	entity._glbParsed = null;
	entity._glbGPU = null;
	entity._glbStartTick = Renderer.tick; // Fallback animation start time

	var modelPath = GLBModelRegistry.getModelPath(config);
	var boneActions = GLBModelRegistry.getBoneActionPaths(config);

	console.log('[GLBEntityHook] Loading GLB for job ' + jobId + ': ' + modelPath);

	// Check if already uploaded to GPU
	var cachedGPU = GLBCache.getGPU(modelPath);
	if (cachedGPU) {
		GLBCache.get(modelPath, function (parsed) {
			if (parsed) {
				entity._glbParsed = parsed;
				entity._glbGPU = cachedGPU;
				entity._glbGPU.scale = config.scale || 0.15;
				entity._glbReady = true;
				_addToList(entity);
				console.log('[GLBEntityHook] Entity ready (cached GPU) for job ' + jobId);
			}
		});
		return;
	}

	// Load main model via Client.loadFile
	GLBCache.get(modelPath, function (parsed) {
		if (!parsed) {
			console.warn('[GLBEntityHook] Failed to load model: ' + modelPath);
			entity._useGLB = false;
			return;
		}

		console.log('[GLBEntityHook] Model parsed OK: ' + modelPath +
			' (meshes: ' + parsed.meshes.length +
			', anims: ' + parsed.animations.length +
			', skins: ' + parsed.skins.length + ')');

		// Load bone actions and merge
		GLBCache.loadAllBones(boneActions, parsed, function (mergedParsed) {
			try {
				var gl = Renderer.getContext();
				if (!gl) {
					console.warn('[GLBEntityHook] No GL context');
					entity._useGLB = false;
					return;
				}

				var gpu = GLBCache.getGPU(modelPath);
				if (!gpu) {
					gpu = GLBRenderer.uploadMesh(gl, mergedParsed);
					if (!gpu) {
						console.error('[GLBEntityHook] uploadMesh returned null');
						entity._useGLB = false;
						return;
					}
					GLBCache.setGPU(modelPath, gpu);
				}

				gpu.scale = config.scale || 0.15;
				entity._glbParsed = mergedParsed;
				entity._glbGPU = gpu;
				entity._glbReady = true;

				_addToList(entity);
				console.log('%c[GLBEntityHook] Entity READY for job ' + jobId +
					' (primitives: ' + gpu.primitives.length + ')',
					'color: #4CAF50; font-weight: bold');
			} catch (e) {
				console.error('[GLBEntityHook] Error uploading to GPU:', e);
				entity._useGLB = false;
			}
		});
	});
};

/**
 * Remove GLB state from an entity
 */
GLBEntityHook._removeGLBEntity = function _removeGLBEntity(entity) {
	entity._useGLB = false;
	entity._glbReady = false;
	entity._glbParsed = null;
	entity._glbGPU = null;
	entity._glbConfig = null;
	_removeFromList(entity);
};

/**
 * Hook 2: Wrap EntityManager.render
 *
 * CRITICAL: The original render MUST ALWAYS be called.
 * All our code is wrapped in try-catch.
 */
GLBEntityHook._hookEntityManager = function _hookEntityManager() {
	var _originalRender = EntityManager.render;

	EntityManager.render = function (gl, modelView, projection, fog, renderEffects) {
		// --- Pre-render: Try to hide sprite body for GLB entities ---
		try {
			for (var i = 0; i < _glbEntities.length; i++) {
				var ent = _glbEntities[i];
				if (ent._useGLB && ent._glbReady && ent.files && ent.files.body) {
					ent._savedBodySpr = ent.files.body.spr;
					ent._savedBodyAct = ent.files.body.act;
					ent.files.body.spr = null;
					ent.files.body.act = null;
				}
			}
		} catch (e) {
			console.error('[GLBEntityHook] Error hiding sprites:', e);
		}

		// --- ALWAYS run original render ---
		_originalRender.call(EntityManager, gl, modelView, projection, fog, renderEffects);

		// --- Post-render: Restore sprite body ---
		try {
			for (var i = 0; i < _glbEntities.length; i++) {
				var ent = _glbEntities[i];
				if (ent._savedBodySpr !== undefined) {
					ent.files.body.spr = ent._savedBodySpr;
					ent.files.body.act = ent._savedBodyAct;
					delete ent._savedBodySpr;
					delete ent._savedBodyAct;
				}
			}
		} catch (e) {
			console.error('[GLBEntityHook] Error restoring sprites:', e);
		}

		// Skip GLB render on effects pass
		if (renderEffects) return;

		// --- GLB Render Pass (fully protected) ---
		try {
			_renderGLBEntities(gl, fog);
		} catch (e) {
			console.error('[GLBEntityHook] Error in GLB render pass:', e);
		}
	};
};

/**
 * Render all GLB entities
 */
var _renderCallCount = 0;

function _renderGLBEntities(gl, fog) {
	_renderCallCount++;

	// Diagnostic: log first few calls to understand entry conditions
	if (_renderCallCount <= 3) {
		var light = MapRenderer.light;
		console.log('[GLBEntityHook] _renderGLBEntities call #' + _renderCallCount +
			': entities=' + _glbEntities.length +
			' light=' + !!light +
			' gl=' + !!gl);

		if (_glbEntities.length > 0) {
			for (var d = 0; d < Math.min(_glbEntities.length, 3); d++) {
				var ent = _glbEntities[d];
				console.log('[GLBEntityHook]   Entity[' + d + ']: useGLB=' + ent._useGLB +
					' ready=' + ent._glbReady +
					' effectColor=' + (ent.effectColor ? '[' + ent.effectColor[0] + ',' + ent.effectColor[3] + ']' : 'null') +
					' position=' + (ent.position ? '[' + ent.position[0] + ',' + ent.position[1] + ']' : 'null') +
					' parsed=' + !!ent._glbParsed +
					' gpu=' + !!ent._glbGPU +
					' remove_tick=' + (ent.remove_tick || 'none'));
			}
		}
	}

	if (_glbEntities.length === 0) return;

	var light = MapRenderer.light;
	if (!light) return;

	var tick = Date.now();

	// Save and set GL state explicitly
	// Enable depth test and depth writes for 3D models (unlike sprites which
	// use depthMask=false, 3D models need proper depth to self-occlude)
	if (GLBRenderer.debugMode === 6) {
		// Debug mode 6: disable depth test to show full model (ignoring ground occlusion)
		gl.disable(gl.DEPTH_TEST);
	} else {
		gl.enable(gl.DEPTH_TEST);
		gl.depthFunc(gl.LEQUAL);
	}
	gl.depthMask(true);
	gl.enable(gl.BLEND);
	gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
	// CULL_FACE intentionally left disabled - GR2-to-GLB converted models
	// often have flipped winding order from skinning transforms, causing
	// faces to be culled incorrectly when backface culling is enabled.

	var rendered = 0;
	for (var i = _glbEntities.length - 1; i >= 0; i--) {
		var entity = _glbEntities[i];

		// Clean up: entity.clean() hook already removes most stale entities,
		// but keep a safety-net for edge cases (e.g. entity removed externally).
		if (!entity._useGLB || !entity._glbReady) {
			if (!entity._useGLB) _glbEntities.splice(i, 1);
			continue;
		}
		if (!entity.effectColor || !entity.effectColor[3]) continue;
		if (!entity.position) continue;

		var parsed = entity._glbParsed;
		var gpu = entity._glbGPU;
		if (!parsed || !gpu) continue;

		// Compute skinning animation
		var jointMatrices = null;
		var isStatic = entity._glbConfig && entity._glbConfig.static;

		if (parsed.skins && parsed.skins.length > 0 && isStatic) {
			// Static mode: use the bind pose (default node TRS, no animation).
			// This gives the model its original rest position (e.g. flag straight).
			// Cached to avoid recomputing every frame.
			if (entity._glbStaticJoints) {
				jointMatrices = entity._glbStaticJoints;
			} else {
				jointMatrices = GLBSkinning.computeBindPoseMatrices(parsed, 0);
				entity._glbStaticJoints = jointMatrices;
			}
		} else if (parsed.skins && parsed.skins.length > 0 &&
			parsed.animations && parsed.animations.length > 0) {

			var clip = GLBAnimationMapper.getClip(entity, parsed,
				entity._glbConfig ? entity._glbConfig.animMap : null);

			if (clip && clip.duration > 0) {
				var animTime;

				// Determine animation start tick:
				// 1. entity.animation.tick: set by setAction() when action changes
				//    (use > 0 check, not truthiness, because 0 is a valid but
				//    uninitialized value that would be falsy)
				// 2. entity._glbStartTick: set when entity GLB loading started
				// 3. Renderer.tick: last resort (animation frozen at frame 0)
				var animTick;
				if (entity.animation && entity.animation.tick > 0) {
					animTick = entity.animation.tick;
				} else {
					animTick = entity._glbStartTick || Renderer.tick;
				}
				animTime = (Renderer.tick - animTick) / 1000.0;

				// Loop repeating animations, clamp non-repeating
				var repeat = entity.animation ? entity.animation.repeat : true;
				if (repeat !== false) {
					animTime = animTime % clip.duration;
				} else {
					animTime = Math.min(animTime, clip.duration);
				}

				jointMatrices = GLBSkinning.computeJointMatrices(parsed, 0, clip, animTime);
			}
		}

		// Handle fade-out
		if (entity.remove_tick) {
			var alpha = 1 - (Renderer.tick - entity.remove_tick) / entity.remove_delay;
			if (alpha <= 0) continue;
			entity.effectColor[3] = Math.max(0, alpha);
		}

		GLBRenderer.renderEntity(gl, entity, gpu, jointMatrices, fog, light);
		rendered++;
	}

	// One-time diagnostic log on first successful render
	if (rendered > 0 && !_firstRenderLogged) {
		_firstRenderLogged = true;
		console.log('%c[GLBEntityHook] First GLB render: ' + rendered + ' entity(ies) drawn, ' +
			_glbEntities.length + ' total in list',
			'color: #4CAF50; font-weight: bold');
	}

	// Restore GL state for subsequent passes
	if (GLBRenderer.debugMode === 6) {
		gl.enable(gl.DEPTH_TEST);
	}
	gl.depthFunc(gl.LESS);
	gl.depthMask(true);
}

function _addToList(entity) {
	for (var i = _glbEntities.length - 1; i >= 0; i--) {
		if (_glbEntities[i] === entity) return; // same object already in list
		if (_glbEntities[i].GID === entity.GID) {
			// Different object, same GID — old entity was replaced (vanish + re-enter)
			_glbEntities[i]._useGLB = false;
			_glbEntities.splice(i, 1);
		}
	}
	_glbEntities.push(entity);
}

function _removeFromList(entity) {
	for (var i = 0; i < _glbEntities.length; i++) {
		if (_glbEntities[i] === entity) {
			_glbEntities.splice(i, 1);
			return;
		}
	}
}

export default GLBEntityHook;
