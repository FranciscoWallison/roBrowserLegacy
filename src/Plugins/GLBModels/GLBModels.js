/**
 * Plugins/GLBModels/GLBModels.js
 *
 * Plugin entry point for GLB (glTF Binary) 3D model support.
 *
 * This plugin replaces 2D sprite rendering for specified entities with
 * 3D GLB model rendering. When not loaded, the original sprite fallback
 * behavior remains unchanged.
 *
 * Configuration in Config.local.js:
 *
 *   plugins: {
 *       GLBModels: {
 *           path: 'GLBModels/GLBModels',
 *           pars: {
 *               modelsUrl: 'data/glb/',
 *               models: {
 *                   1002: { file: 'poring.glb', scale: 0.15 },
 *                   1288: { file: 'emperium.glb', scale: 0.2 },
 *                   1285: { file: 'guardian.glb', scale: 0.18,
 *                           animMap: { IDLE: ['guard_idle'] } }
 *               }
 *           }
 *       }
 *   }
 *
 * GLB Model Requirements:
 *   - Format: glTF 2.0 Binary (.glb)
 *   - Coordinate system: Y-up (glTF default)
 *   - Scale: ~1 unit = 1 meter (adjust via 'scale' config, typically 0.1-0.3)
 *   - Animation clip names: 'idle', 'walk', 'attack', 'hurt', 'die' (lowercase)
 *   - Max joints for skinning: 64
 *   - Textures: embedded in GLB, power-of-two recommended
 *   - Fewer materials = fewer draw calls = better performance
 */
import GLBModelRegistry from './GLBModelRegistry.js';
import GLBRenderer from './GLBRenderer.js';
import GLBEntityHook from './GLBEntityHook.js';
import EntityManager from 'Renderer/EntityManager.js';

/**
 * Plugin initialization function.
 * Called by PluginManager with the 'pars' object from config.
 *
 * @param {object} params - plugin parameters
 * @returns {boolean} true if initialization succeeded
 */
export default function GLBModelsPlugin(params) {
	try {
		// Initialize model registry from config
		GLBModelRegistry.init(params);

		// Initialize the WebGL2 renderer (lazy - actual GL init on first use)
		GLBRenderer.init(params);

		// Install hooks into the entity rendering pipeline
		GLBEntityHook.install();

		console.log('%c[GLBModels] Plugin initialized successfully', 'color: #4CAF50; font-weight: bold');

		if (params && params.models) {
			var modelCount = Object.keys(params.models).length;
			console.log('[GLBModels] Registered ' + modelCount + ' model(s)');
		}

		// Expose debug helper on all accessible windows for console access
		// (roBrowser may run in an iframe)
		var debugObj = {
			setMode: function(mode) {
				GLBRenderer.debugMode = mode;
				console.log('[GLBDebug] Mode set to ' + mode +
					' (0=normal, 1=flat red, 2=normals, 3=UVs, 4=depth, 5=unlit texture)');
			},
			renderer: GLBRenderer,
			registry: GLBModelRegistry,
			entityManager: EntityManager,
			findByJob: function(jobId) {
				var found = [];
				EntityManager.forEach(function(entity) {
					if (entity._job === jobId) found.push(entity);
				});
				return found;
			},
			listGLB: function() {
				var list = [];
				EntityManager.forEach(function(entity) {
					if (entity._useGLB) {
						list.push({ GID: entity.GID, job: entity._job, ready: entity._glbReady, GUID: entity.GUID, name: entity.display ? entity.display.name : '?' });
					}
				});
				console.table(list);
				return list;
			},
			// List all primitives of a job's model with mesh/material names
			listMeshes: function(jobId) {
				var flags = this.findByJob(jobId || 722);
				if (flags.length === 0) { console.error('No entity with job ' + (jobId || 722)); return; }
				var gpu = flags[0]._glbGPU;
				if (!gpu) { console.error('Model not loaded yet'); return; }
				gpu.primitives.forEach(function(p, i) {
					console.log('[GLBDebug] Prim[' + i + '] mesh="' + p.meshName +
						'" mat="' + p.materialName +
						'" verts=' + p.vertexCount +
						' indices=' + (p.hasIndices ? p.indexCount : 'none') +
						' skinning=' + p.hasSkinning);
				});
				return gpu.primitives.length;
			},
			// Color a specific mesh by index (0, 1, ...) to identify it visually
			// Usage: GLBDebug.colorMesh(722, 0, 1,0,0,1) = Prim[0] red
			//        GLBDebug.colorMesh(722, 1, 0,1,0,1) = Prim[1] green
			colorMesh: function(jobId, primIndex, r, g, b, a) {
				var flags = this.findByJob(jobId || 722);
				if (flags.length === 0) { console.error('No entity with job ' + (jobId || 722)); return; }
				var gpu = flags[0]._glbGPU;
				if (!gpu) { console.error('Model not loaded yet'); return; }
				if (primIndex >= gpu.primitives.length) { console.error('Prim index ' + primIndex + ' out of range (max ' + (gpu.primitives.length-1) + ')'); return; }
				var p = gpu.primitives[primIndex];
				p.baseColorFactor = new Float32Array([
					r !== undefined ? r : 1,
					g !== undefined ? g : 1,
					b !== undefined ? b : 1,
					a !== undefined ? a : 1
				]);
				console.log('[GLBDebug] Prim[' + primIndex + '] ("' + p.meshName + '") color set to [' +
					p.baseColorFactor[0] + ',' + p.baseColorFactor[1] + ',' +
					p.baseColorFactor[2] + ',' + p.baseColorFactor[3] + ']');
			},
			// Color all meshes with different colors to identify them
			// Usage: GLBDebug.highlightAll(722)
			highlightAll: function(jobId) {
				var colors = [
					[1, 0, 0, 1],  // Prim[0] = RED
					[0, 1, 0, 1],  // Prim[1] = GREEN
					[0, 0, 1, 1],  // Prim[2] = BLUE
					[1, 1, 0, 1],  // Prim[3] = YELLOW
					[1, 0, 1, 1],  // Prim[4] = MAGENTA
					[0, 1, 1, 1]   // Prim[5] = CYAN
				];
				var flags = this.findByJob(jobId || 722);
				if (flags.length === 0) { console.error('No entity with job ' + (jobId || 722)); return; }
				var gpu = flags[0]._glbGPU;
				if (!gpu) { console.error('Model not loaded yet'); return; }
				// Switch to unlit mode so colors are clear
				GLBRenderer.debugMode = 5;
				gpu.primitives.forEach(function(p, i) {
					var c = colors[i % colors.length];
					p.baseColorFactor = new Float32Array(c);
					console.log('[GLBDebug] Prim[' + i + '] ("' + p.meshName + '" mat="' + p.materialName + '") = ' +
						['RED','GREEN','BLUE','YELLOW','MAGENTA','CYAN'][i % 6]);
				});
				console.log('%c[GLBDebug] Meshes highlighted! (debugMode=5 unlit)', 'color:#FF6600;font-weight:bold');
			},
			// Reset colors back to original (reload required for exact originals)
			resetColors: function(jobId) {
				var flags = this.findByJob(jobId || 722);
				if (flags.length === 0) { console.error('No entity with job ' + (jobId || 722)); return; }
				var gpu = flags[0]._glbGPU;
				if (!gpu) return;
				gpu.primitives.forEach(function(p) {
					p.baseColorFactor = new Float32Array([0.8, 0.8, 0.8, 1]);
				});
				GLBRenderer.debugMode = 0;
				console.log('[GLBDebug] Colors reset, debugMode=0');
			},
			injectEmblem: function(jobId) {
				var flags = this.findByJob(jobId || 722);
				if (flags.length === 0) { console.error('No entity with job ' + (jobId || 722)); return; }
				var flag = flags[0];
				var c = document.createElement('canvas');
				c.width = 24; c.height = 24;
				var ctx = c.getContext('2d');
				ctx.fillStyle = '#0044AA'; ctx.fillRect(0,0,24,24);
				ctx.fillStyle = '#FFD700'; ctx.fillRect(10,2,4,20); ctx.fillRect(4,8,16,4);
				ctx.strokeStyle = '#FFF'; ctx.lineWidth = 1; ctx.strokeRect(0.5,0.5,23,23);
				var img = new Image();
				img.onload = function() {
					flag.GUID = 99; flag.GEmblemVer = 1; flag.display.emblem = img;
					console.log('%c[GLBDebug] Emblem injected on job ' + flag._job + ' GID=' + flag.GID, 'color:#4CAF50;font-weight:bold');
					console.log('[GLBDebug] Adjust with: GLBDebug.emblemLayout(scale, offsetX, offsetY)');
				};
				img.src = c.toDataURL('image/png');
			},
			// Adjust emblem scale/position on the flag and force re-render.
			// scale: 0.0-1.0 (how much of the plane the emblem fills, default 0.5)
			// offsetX/offsetY: -1.0 to 1.0 (shift from center, default 0)
			// bg: background color string or null for transparent
			// Usage: GLBDebug.emblemLayout(0.6, 0, -0.1)
			emblemLayout: function(scale, offsetX, offsetY, bg) {
				var flags = this.findByJob(722);
				if (flags.length === 0) { console.error('No flag entity (job 722)'); return; }
				var flag = flags[0];
				if (!flag._glbConfig) { console.error('No GLB config on flag'); return; }
				flag._glbConfig.emblemScale = scale !== undefined ? scale : 0.5;
				flag._glbConfig.emblemOffsetX = offsetX || 0;
				flag._glbConfig.emblemOffsetY = offsetY || 0;
				if (bg !== undefined) flag._glbConfig.emblemBg = bg;
				// Bump version to force texture re-creation
				flag.GEmblemVer = (flag.GEmblemVer || 0) + 1;
				console.log('[GLBDebug] Emblem layout: scale=' + flag._glbConfig.emblemScale +
					' offset=[' + flag._glbConfig.emblemOffsetX + ',' + flag._glbConfig.emblemOffsetY + ']' +
					(bg ? ' bg=' + bg : '') + ' (ver=' + flag.GEmblemVer + ')');
			}
		};
		try { window.GLBDebug = debugObj; } catch(e) {}
		try { if (window.top !== window) window.top.GLBDebug = debugObj; } catch(e) {}
		try { if (window.parent !== window) window.parent.GLBDebug = debugObj; } catch(e) {}
		console.log('%c[GLBModels] Debug: use GLBDebug.setMode(1) in console for flat red test',
			'color: #2196F3');

		return true;
	} catch (e) {
		console.error('[GLBModels] Plugin initialization failed:', e);
		return false;
	}
}
