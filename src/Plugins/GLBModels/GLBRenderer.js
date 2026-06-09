/**
 * Plugins/GLBModels/GLBRenderer.js
 *
 * WebGL2 renderer for GLB model entities.
 * Handles shader compilation, mesh upload to GPU, and per-entity rendering.
 * Uses the same lighting/fog model as roBrowser's existing Models renderer.
 */
import WebGL from 'Utils/WebGL.js';
import glMatrix from 'Utils/gl-matrix.js';
import Camera from 'Renderer/Camera.js';
import Renderer from 'Renderer/Renderer.js';
import Ground from 'Renderer/Map/Ground.js';
import GLBSkinning from './GLBSkinning.js';
import _vertexShader from './GLBRenderer.vs?raw';
import _fragmentShader from './GLBRenderer.fs?raw';

var mat4 = glMatrix.mat4;
var mat3 = glMatrix.mat3;

var GLBRenderer = {};

/**
 * @var {WebGLProgram} shader program
 */
var _program = null;

/**
 * @var {object} plugin params
 */
var _params = null;

/**
 * @var {WebGLTexture} 1x1 white fallback texture
 */
var _whiteTexture = null;

/**
 * @var {boolean} one-time uniform validation flag
 */
var _uniformsValidated = false;

/**
 * @var {object} guild emblem texture cache: guildId -> { texture, version, width, height }
 */
var _emblemTextures = {};

/**
 * @var {number} debug render mode (0=normal, 1=flat red, 2=normals, 3=UVs, 4=depth, 5=unlit)
 * Change via GLBRenderer.debugMode = N or from browser console:
 *   require('Plugins/GLBModels/GLBRenderer').debugMode = 1
 */
GLBRenderer.debugMode = 0;

/**
 * @var {number} frame counter for diagnostics
 */
var _frameCount = 0;

/**
 * Initialize renderer (deferred - actual GL init happens on first use)
 */
GLBRenderer.init = function init(params) {
	_params = params || {};
	console.log('[GLBRenderer] Initialized (shaders loaded: ' +
		(typeof _vertexShader === 'string' ? 'YES' : 'NO') + ')');
};

/**
 * Ensure shader program is compiled.
 * Returns false if shader compilation failed.
 *
 * @param {WebGLRenderingContext} gl
 * @returns {boolean}
 */
GLBRenderer._ensureProgram = function _ensureProgram(gl) {
	if (_program) return true;

	try {
		_program = WebGL.createShaderProgram(gl, _vertexShader, _fragmentShader);

		// Create 1x1 white texture for untextured materials
		_whiteTexture = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, _whiteTexture);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
			new Uint8Array([255, 255, 255, 255]));

		// Log discovered uniforms and attributes for debugging
		console.log('[GLBRenderer] Shader compiled OK');
		console.log('[GLBRenderer] Attributes:', Object.keys(_program.attribute));
		console.log('[GLBRenderer] Uniforms:', Object.keys(_program.uniform));

		return true;
	} catch (e) {
		console.error('[GLBRenderer] Shader compilation FAILED:', e);
		_program = null;
		return false;
	}
};

/**
 * Helper: get uniform location, handling array uniforms like uJointMatrices[0]
 */
function _getUniform(name) {
	if (!_program || !_program.uniform) return null;
	// Try exact name first, then array form [0]
	return _program.uniform[name] !== undefined
		? _program.uniform[name]
		: (_program.uniform[name + '[0]'] !== undefined
			? _program.uniform[name + '[0]']
			: null);
}

/**
 * Compute global transforms for all nodes in a glTF node hierarchy.
 * Used to apply node transforms to non-skinned meshes.
 *
 * @param {Array} nodes - parsed nodes array
 * @returns {Array} array of mat4 global transforms
 */
GLBRenderer._computeNodeGlobals = function _computeNodeGlobals(nodes) {
	var globals = new Array(nodes.length);

	function computeLocal(node) {
		var local = mat4.create();
		if (node.matrix) {
			mat4.copy(local, node.matrix);
		} else {
			mat4.fromRotationTranslation(local, node.rotation, node.translation);
			mat4.scale(local, local, node.scale);
		}
		return local;
	}

	function computeGlobal(index) {
		if (globals[index]) return globals[index];
		var local = computeLocal(nodes[index]);
		var parentIdx = nodes[index].parent;
		if (parentIdx >= 0) {
			var parentGlobal = computeGlobal(parentIdx);
			globals[index] = mat4.create();
			mat4.multiply(globals[index], parentGlobal, local);
		} else {
			globals[index] = local;
		}
		return globals[index];
	}

	for (var i = 0; i < nodes.length; i++) {
		computeGlobal(i);
	}
	return globals;
};

/**
 * Check if a mat4 is (approximately) the identity matrix
 */
GLBRenderer._isIdentityMat4 = function _isIdentityMat4(m) {
	var identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
	for (var i = 0; i < 16; i++) {
		if (Math.abs(m[i] - identity[i]) > 0.0001) return false;
	}
	return true;
};

/**
 * Compute skinned bounding box by transforming all vertices through bind-pose
 * joint matrices. This gives us the correct Y range after the skeleton's
 * coordinate system rotation (e.g. Z-up → Y-up for GR2 models).
 *
 * @param {object} parsedGLB - parsed GLB data
 * @param {object} gpuHandle - GPU handle to update with skinned bbox
 */
GLBRenderer._computeSkinnedBoundingBox = function _computeSkinnedBoundingBox(parsedGLB, gpuHandle) {
	if (!parsedGLB.skins || parsedGLB.skins.length === 0) return;

	// Compute joint matrices at time 0 (bind pose) using first animation clip
	var firstClip = (parsedGLB.animations && parsedGLB.animations.length > 0)
		? parsedGLB.animations[0]
		: { name: 'dummy', duration: 0, channels: [] };

	var jointMats = GLBSkinning.computeJointMatrices(parsedGLB, 0, firstClip, 0);
	if (!jointMats) return;

	var sMinX = Infinity, sMaxX = -Infinity;
	var sMinY = Infinity, sMaxY = -Infinity;
	var sMinZ = Infinity, sMaxZ = -Infinity;
	var hasSkinnedVerts = false;

	for (var mi = 0; mi < parsedGLB.meshes.length; mi++) {
		var prims = parsedGLB.meshes[mi].primitives;
		for (var pi = 0; pi < prims.length; pi++) {
			var prim = prims[pi];
			if (!prim.positions) continue;

			var positions = prim.positions;
			var joints = prim.joints;
			var weights = prim.weights;
			var vertCount = positions.length / 3;

			if (joints && weights) {
				// Skinned mesh: transform each vertex through joint matrices
				hasSkinnedVerts = true;
				for (var v = 0; v < vertCount; v++) {
					var px = positions[v * 3];
					var py = positions[v * 3 + 1];
					var pz = positions[v * 3 + 2];

					var j0 = joints[v * 4], j1 = joints[v * 4 + 1];
					var j2 = joints[v * 4 + 2], j3 = joints[v * 4 + 3];
					var w0 = weights[v * 4], w1 = weights[v * 4 + 1];
					var w2 = weights[v * 4 + 2], w3 = weights[v * 4 + 3];

					var sx = 0, sy = 0, sz = 0;
					var off;

					// Joint 0 (always has weight)
					off = j0 * 16;
					sx += w0 * (jointMats[off] * px + jointMats[off + 4] * py + jointMats[off + 8] * pz + jointMats[off + 12]);
					sy += w0 * (jointMats[off + 1] * px + jointMats[off + 5] * py + jointMats[off + 9] * pz + jointMats[off + 13]);
					sz += w0 * (jointMats[off + 2] * px + jointMats[off + 6] * py + jointMats[off + 10] * pz + jointMats[off + 14]);

					if (w1 > 0) {
						off = j1 * 16;
						sx += w1 * (jointMats[off] * px + jointMats[off + 4] * py + jointMats[off + 8] * pz + jointMats[off + 12]);
						sy += w1 * (jointMats[off + 1] * px + jointMats[off + 5] * py + jointMats[off + 9] * pz + jointMats[off + 13]);
						sz += w1 * (jointMats[off + 2] * px + jointMats[off + 6] * py + jointMats[off + 10] * pz + jointMats[off + 14]);
					}
					if (w2 > 0) {
						off = j2 * 16;
						sx += w2 * (jointMats[off] * px + jointMats[off + 4] * py + jointMats[off + 8] * pz + jointMats[off + 12]);
						sy += w2 * (jointMats[off + 1] * px + jointMats[off + 5] * py + jointMats[off + 9] * pz + jointMats[off + 13]);
						sz += w2 * (jointMats[off + 2] * px + jointMats[off + 6] * py + jointMats[off + 10] * pz + jointMats[off + 14]);
					}
					if (w3 > 0) {
						off = j3 * 16;
						sx += w3 * (jointMats[off] * px + jointMats[off + 4] * py + jointMats[off + 8] * pz + jointMats[off + 12]);
						sy += w3 * (jointMats[off + 1] * px + jointMats[off + 5] * py + jointMats[off + 9] * pz + jointMats[off + 13]);
						sz += w3 * (jointMats[off + 2] * px + jointMats[off + 6] * py + jointMats[off + 10] * pz + jointMats[off + 14]);
					}

					if (sx < sMinX) sMinX = sx; if (sx > sMaxX) sMaxX = sx;
					if (sy < sMinY) sMinY = sy; if (sy > sMaxY) sMaxY = sy;
					if (sz < sMinZ) sMinZ = sz; if (sz > sMaxZ) sMaxZ = sz;
				}
			} else {
				// Non-skinned: use rest-pose positions directly
				for (var v2 = 0; v2 < positions.length; v2 += 3) {
					var vx = positions[v2], vy = positions[v2 + 1], vz = positions[v2 + 2];
					if (vx < sMinX) sMinX = vx; if (vx > sMaxX) sMaxX = vx;
					if (vy < sMinY) sMinY = vy; if (vy > sMaxY) sMaxY = vy;
					if (vz < sMinZ) sMinZ = vz; if (vz > sMaxZ) sMaxZ = vz;
				}
			}
		}
	}

	if (hasSkinnedVerts && isFinite(sMinY)) {
		gpuHandle.skinnedBoundingBox = {
			min: [sMinX, sMinY, sMinZ],
			max: [sMaxX, sMaxY, sMaxZ]
		};
		// Override baseY with the skinned minimum Y (the actual bottom after rotation)
		gpuHandle.baseY = sMinY;
		console.log('[GLBRenderer] Skinned BBox: min=[' + sMinX.toFixed(2) + ',' + sMinY.toFixed(2) + ',' + sMinZ.toFixed(2) +
			'] max=[' + sMaxX.toFixed(2) + ',' + sMaxY.toFixed(2) + ',' + sMaxZ.toFixed(2) +
			'] baseY=' + sMinY.toFixed(2));
	}
};

/**
 * Upload parsed GLB data to GPU
 *
 * @param {WebGLRenderingContext} gl
 * @param {object} parsedGLB - output from GLBLoader.parse()
 * @returns {object|null} GPU handle with primitives array, or null on failure
 */
GLBRenderer.uploadMesh = function uploadMesh(gl, parsedGLB) {
	if (!this._ensureProgram(gl)) {
		return null;
	}

	var gpuHandle = {
		primitives: [],
		textures: [],
		scale: 0.15
	};

	// Upload textures from embedded images
	var glTextures = [];
	for (var i = 0; i < parsedGLB.images.length; i++) {
		var img = parsedGLB.images[i];
		if (img.data) {
			glTextures[i] = this._uploadImageTexture(gl, img);
		} else {
			glTextures[i] = null;
		}
	}
	gpuHandle.textures = glTextures;

	// Build texture index map from glTF textures array
	var textureSourceMap = {};
	if (parsedGLB.json.textures) {
		for (var t = 0; t < parsedGLB.json.textures.length; t++) {
			var srcTex = parsedGLB.json.textures[t];
			textureSourceMap[t] = srcTex.source !== undefined ? srcTex.source : -1;
		}
	}

	// Build mesh-to-node map and compute node global transforms.
	// glTF meshes can be under nodes with transforms (scale, rotation, etc.)
	// that must be applied for correct rendering.
	var meshNodeMap = {};
	if (parsedGLB.nodes) {
		for (var n = 0; n < parsedGLB.nodes.length; n++) {
			if (parsedGLB.nodes[n].mesh >= 0 && meshNodeMap[parsedGLB.nodes[n].mesh] === undefined) {
				meshNodeMap[parsedGLB.nodes[n].mesh] = n;
			}
		}
	}

	var nodeGlobals = (parsedGLB.nodes && parsedGLB.nodes.length > 0)
		? this._computeNodeGlobals(parsedGLB.nodes) : [];

	// Upload each mesh's primitives
	for (var m = 0; m < parsedGLB.meshes.length; m++) {
		var mesh = parsedGLB.meshes[m];

		// Determine node transform for this mesh (non-skinned only)
		var nodeTransform = null;
		var nodeIdx = meshNodeMap[m];
		if (nodeIdx !== undefined) {
			var node = parsedGLB.nodes[nodeIdx];
			// Only apply node transform for non-skinned meshes
			// (skinned meshes get their transforms from the skinning pipeline)
			if (node.skin < 0 && nodeGlobals[nodeIdx]) {
				if (!this._isIdentityMat4(nodeGlobals[nodeIdx])) {
					nodeTransform = new Float32Array(nodeGlobals[nodeIdx]);
					console.log('[GLBRenderer] Mesh ' + m + ' (' + mesh.name + ') has node transform:',
						'T=[' + nodeTransform[12].toFixed(2) + ',' + nodeTransform[13].toFixed(2) + ',' + nodeTransform[14].toFixed(2) + ']',
						'S~' + Math.sqrt(nodeTransform[0] * nodeTransform[0] + nodeTransform[1] * nodeTransform[1] + nodeTransform[2] * nodeTransform[2]).toFixed(3));
				}
			}
		}

		for (var p = 0; p < mesh.primitives.length; p++) {
			var prim = mesh.primitives[p];
			var gpuPrim = this._uploadPrimitive(gl, prim, parsedGLB.materials,
				glTextures, textureSourceMap);
			if (gpuPrim) {
				// Don't apply node transform for skinned primitives.
				// Skinning joint matrices already include the full transform
				// chain; applying nodeTransform too would double-transform
				// the vertices, causing ghost/duplicate geometry.
				gpuPrim.nodeTransform = gpuPrim.hasSkinning ? null : nodeTransform;
				gpuPrim.meshName = mesh.name || '';
				gpuPrim.materialName = (prim.materialIndex >= 0 && parsedGLB.materials && prim.materialIndex < parsedGLB.materials.length)
					? (parsedGLB.materials[prim.materialIndex].name || '') : '';
				gpuHandle.primitives.push(gpuPrim);
			}
		}
	}

	// Compute bounding box from all primitives' vertex positions (rest pose).
	// This is used to determine the Y offset so the model's base sits at ground level.
	var minY = Infinity, maxY = -Infinity;
	var minX = Infinity, maxX = -Infinity;
	var minZ = Infinity, maxZ = -Infinity;
	for (var m2 = 0; m2 < parsedGLB.meshes.length; m2++) {
		for (var p2 = 0; p2 < parsedGLB.meshes[m2].primitives.length; p2++) {
			var positions = parsedGLB.meshes[m2].primitives[p2].positions;
			if (!positions) continue;
			for (var v = 0; v < positions.length; v += 3) {
				var vx = positions[v], vy = positions[v + 1], vz = positions[v + 2];
				if (vx < minX) minX = vx; if (vx > maxX) maxX = vx;
				if (vy < minY) minY = vy; if (vy > maxY) maxY = vy;
				if (vz < minZ) minZ = vz; if (vz > maxZ) maxZ = vz;
			}
		}
	}
	gpuHandle.boundingBox = {
		min: [minX, minY, minZ],
		max: [maxX, maxY, maxZ]
	};
	// baseY: the minimum Y in local space. Used to offset the model so its base
	// sits at ground level instead of its center/origin.
	gpuHandle.baseY = isFinite(minY) ? minY : 0;

	console.log('[GLBRenderer] Uploaded ' + gpuHandle.primitives.length + ' primitives, ' +
		glTextures.length + ' textures');
	console.log('[GLBRenderer] Rest BBox: min=[' + minX.toFixed(2) + ',' + minY.toFixed(2) + ',' + minZ.toFixed(2) +
		'] max=[' + maxX.toFixed(2) + ',' + maxY.toFixed(2) + ',' + maxZ.toFixed(2) +
		'] baseY=' + gpuHandle.baseY.toFixed(2));

	// Compute SKINNED bounding box for models with skeleton.
	// GR2-to-GLB models store rest-pose vertices in Z-up space, but the skinning
	// joint matrices rotate Z→Y. The rest-pose minY is a horizontal axis, NOT
	// the actual height. We must transform vertices through the bind-pose skinning
	// to get the correct Y range for positioning.
	this._computeSkinnedBoundingBox(parsedGLB, gpuHandle);

	return gpuHandle;
};

/**
 * Upload a single mesh primitive to GPU
 */
GLBRenderer._uploadPrimitive = function _uploadPrimitive(gl, prim, materials, glTextures, textureSourceMap) {
	if (!prim.positions) return null;

	var attribute = _program.attribute;
	var vao = gl.createVertexArray();
	gl.bindVertexArray(vao);

	// Position buffer
	var posBuf = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
	gl.bufferData(gl.ARRAY_BUFFER, prim.positions, gl.STATIC_DRAW);
	if (attribute.aPosition !== undefined) {
		gl.enableVertexAttribArray(attribute.aPosition);
		gl.vertexAttribPointer(attribute.aPosition, 3, gl.FLOAT, false, 0, 0);
	}

	// Normal buffer
	var normBuf = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, normBuf);
	gl.bufferData(gl.ARRAY_BUFFER, prim.normals, gl.STATIC_DRAW);
	if (attribute.aNormal !== undefined) {
		gl.enableVertexAttribArray(attribute.aNormal);
		gl.vertexAttribPointer(attribute.aNormal, 3, gl.FLOAT, false, 0, 0);
	}

	// TexCoord buffer
	var uvBuf = null;
	if (prim.texcoords && attribute.aTexCoord !== undefined) {
		uvBuf = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
		gl.bufferData(gl.ARRAY_BUFFER, prim.texcoords, gl.STATIC_DRAW);
		gl.enableVertexAttribArray(attribute.aTexCoord);
		gl.vertexAttribPointer(attribute.aTexCoord, 2, gl.FLOAT, false, 0, 0);
	} else if (attribute.aTexCoord !== undefined) {
		gl.disableVertexAttribArray(attribute.aTexCoord);
		gl.vertexAttrib2f(attribute.aTexCoord, 0, 0);
	}

	// Joint indices buffer (for skinning)
	var jointBuf = null;
	if (prim.joints && attribute.aJoints !== undefined && attribute.aJoints >= 0) {
		jointBuf = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, jointBuf);
		var jointFloat = new Float32Array(prim.joints.length);
		for (var i = 0; i < prim.joints.length; i++) {
			jointFloat[i] = prim.joints[i];
		}
		gl.bufferData(gl.ARRAY_BUFFER, jointFloat, gl.STATIC_DRAW);
		gl.enableVertexAttribArray(attribute.aJoints);
		gl.vertexAttribPointer(attribute.aJoints, 4, gl.FLOAT, false, 0, 0);
	} else if (attribute.aJoints !== undefined && attribute.aJoints >= 0) {
		gl.disableVertexAttribArray(attribute.aJoints);
		gl.vertexAttrib4f(attribute.aJoints, 0, 0, 0, 0);
	}

	// Joint weights buffer (must be Float32Array for gl.FLOAT attribute)
	var weightBuf = null;
	if (prim.weights && attribute.aWeights !== undefined && attribute.aWeights >= 0) {
		weightBuf = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, weightBuf);
		// Ensure weights are Float32Array - glTF may store as Uint8/Uint16 normalized
		var weightData = prim.weights;
		if (!(weightData instanceof Float32Array)) {
			console.log('[GLBRenderer] Converting weights from ' +
				weightData.constructor.name + ' to Float32Array (' + weightData.length + ' values)');
			var floatWeights = new Float32Array(weightData.length);
			for (var w = 0; w < weightData.length; w++) {
				floatWeights[w] = weightData[w];
			}
			weightData = floatWeights;
		}
		gl.bufferData(gl.ARRAY_BUFFER, weightData, gl.STATIC_DRAW);
		gl.enableVertexAttribArray(attribute.aWeights);
		gl.vertexAttribPointer(attribute.aWeights, 4, gl.FLOAT, false, 0, 0);
	} else if (attribute.aWeights !== undefined && attribute.aWeights >= 0) {
		gl.disableVertexAttribArray(attribute.aWeights);
		gl.vertexAttrib4f(attribute.aWeights, 0, 0, 0, 0);
	}

	// Index buffer
	var indexBuf = null;
	var indexCount = 0;
	var indexType = gl.UNSIGNED_SHORT;
	if (prim.indices) {
		indexBuf = gl.createBuffer();
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuf);
		if (prim.indices instanceof Uint32Array) {
			gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, prim.indices, gl.STATIC_DRAW);
			indexType = gl.UNSIGNED_INT;
		} else {
			var indices16 = prim.indices instanceof Uint16Array
				? prim.indices
				: new Uint16Array(prim.indices);
			gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices16, gl.STATIC_DRAW);
			indexType = gl.UNSIGNED_SHORT;
		}
		indexCount = prim.indices.length;
	}

	gl.bindVertexArray(null);

	// Resolve material
	var baseColorFactor = new Float32Array([1, 1, 1, 1]);
	var texture = _whiteTexture;
	var doubleSided = false;

	if (prim.materialIndex >= 0 && materials && prim.materialIndex < materials.length) {
		var mat = materials[prim.materialIndex];
		baseColorFactor = mat.baseColorFactor;
		doubleSided = mat.doubleSided;

		if (mat.baseColorTextureIndex >= 0) {
			var sourceIndex = textureSourceMap[mat.baseColorTextureIndex];
			if (sourceIndex >= 0 && glTextures[sourceIndex]) {
				texture = glTextures[sourceIndex];
			}
		}
	}

	return {
		vao: vao,
		buffers: [posBuf, normBuf, uvBuf, jointBuf, weightBuf, indexBuf].filter(Boolean),
		indexCount: indexCount,
		indexType: indexType,
		vertexCount: prim.positions.length / 3,
		hasIndices: !!prim.indices,
		hasSkinning: !!(prim.joints && prim.weights),
		texture: texture,
		baseColorFactor: baseColorFactor,
		doubleSided: doubleSided
	};
};

/**
 * Upload an embedded image as a WebGL texture
 */
GLBRenderer._uploadImageTexture = function _uploadImageTexture(gl, imageInfo) {
	var blob = new Blob([imageInfo.data], { type: imageInfo.mimeType });
	var url = URL.createObjectURL(blob);
	var tex = gl.createTexture();

	gl.bindTexture(gl.TEXTURE_2D, tex);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
		new Uint8Array([255, 0, 255, 255]));

	var img = new Image();
	img.onload = function () {
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
		gl.generateMipmap(gl.TEXTURE_2D);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
		URL.revokeObjectURL(url);
	};
	img.onerror = function () {
		console.warn('[GLBRenderer] Failed to decode texture:', imageInfo.name);
		URL.revokeObjectURL(url);
	};
	img.src = url;

	return tex;
};

/**
 * Get or create a WebGL texture from an entity's guild emblem.
 * Returns null if no emblem is available.
 * Caches per guild_id and updates when emblem version changes.
 *
 * @param {WebGLRenderingContext} gl
 * @param {Entity} entity
 * @returns {WebGLTexture|null}
 */
GLBRenderer._getEmblemTexture = function _getEmblemTexture(gl, entity) {
	var guildId = entity.GUID;
	if (!guildId || guildId <= 0) return null;

	// Get the emblem image from entity display system
	var emblemImg = null;
	if (entity.display && entity.display.emblem) {
		emblemImg = entity.display.emblem;
	}
	if (!emblemImg) return null;

	// For animated GIF emblems, the image might be a Canvas with sprite sheet.
	// Use first frame (top-left corner) for the 3D texture.
	var isAnimated = emblemImg.isAnimated;
	var srcWidth = isAnimated ? emblemImg.frameWidth : emblemImg.width;
	var srcHeight = isAnimated ? emblemImg.frameHeight : emblemImg.height;

	if (!srcWidth || !srcHeight) return null; // Not loaded yet

	// Check cache - use entity's GEmblemVer to detect updates
	var emblemVer = entity.GEmblemVer || 0;
	var cached = _emblemTextures[guildId];
	if (cached && cached.version >= emblemVer) {
		return cached.texture;
	}

	// Emblem layout config from entity's GLB config:
	//   emblemScale:   0.0-1.0, how much of the UV plane the emblem fills (default 0.5)
	//   emblemOffsetX: -1.0 to 1.0, horizontal shift (0 = center)
	//   emblemOffsetY: -1.0 to 1.0, vertical shift (0 = center)
	//   emblemBg:      background color string (default: transparent)
	var cfg = entity._glbConfig || {};
	var eScale  = cfg.emblemScale   !== undefined ? cfg.emblemScale   : 0.7;
	var eOffX   = cfg.emblemOffsetX !== undefined ? cfg.emblemOffsetX : -0.3;
	var eOffY   = cfg.emblemOffsetY !== undefined ? cfg.emblemOffsetY : -0.1;
	var eBg     = cfg.emblemBg      || null;

	// Render emblem onto a 64x64 canvas with configurable scale/position.
	// The canvas fills the entire UV space of the emblem plane mesh.
	// emblemScale controls how much of that space the emblem icon occupies.
	var texSize = 64;
	var canvas = document.createElement('canvas');
	canvas.width = texSize;
	canvas.height = texSize;
	var ctx = canvas.getContext('2d');

	// Background (transparent by default)
	if (eBg) {
		ctx.fillStyle = eBg;
		ctx.fillRect(0, 0, texSize, texSize);
	}

	// Draw emblem centered with scale and offset
	var drawW = texSize * eScale;
	var drawH = texSize * eScale;
	var drawX = (texSize - drawW) / 2 + (eOffX * texSize / 2);
	var drawY = (texSize - drawH) / 2 + (eOffY * texSize / 2);

	if (isAnimated) {
		// Extract first frame from sprite sheet
		ctx.drawImage(emblemImg, 0, 0, srcWidth, srcHeight, drawX, drawY, drawW, drawH);
	} else {
		ctx.drawImage(emblemImg, drawX, drawY, drawW, drawH);
	}

	// Create or update GL texture
	var tex;
	if (cached) {
		tex = cached.texture;
	} else {
		tex = gl.createTexture();
	}

	gl.bindTexture(gl.TEXTURE_2D, tex);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

	_emblemTextures[guildId] = {
		texture: tex,
		version: emblemVer,
		width: texSize,
		height: texSize
	};

	console.log('[GLBRenderer] Created emblem texture for guild ' + guildId +
		' ver=' + emblemVer + ' (canvas=' + texSize + 'x' + texSize +
		', scale=' + eScale + ', offset=[' + eOffX + ',' + eOffY + '])');

	return tex;
};

/**
 * Render a GLB entity
 */
GLBRenderer.renderEntity = function renderEntity(gl, entity, gpuModel, jointMatrices, fog, light) {
	if (!this._ensureProgram(gl)) return;
	if (!gpuModel || gpuModel.primitives.length === 0) return;

	gl.useProgram(_program);
	var uniform = _program.uniform;

	_frameCount++;

	// One-time validation: check that critical uniforms exist
	if (!_uniformsValidated) {
		_uniformsValidated = true;
		var critical = ['uProjectionMat', 'uModelViewMat', 'uModelMat', 'uNormalMat',
			'uDiffuse', 'uBaseColorFactor', 'uEntityColor', 'uShadowFactor', 'uUseSkinning',
			'uDebugMode'];
		for (var u = 0; u < critical.length; u++) {
			if (uniform[critical[u]] === undefined || uniform[critical[u]] === null) {
				console.warn('[GLBRenderer] Missing uniform: ' + critical[u]);
			}
		}
		console.log('[GLBRenderer] All uniforms:', Object.keys(uniform).join(', '));
	}

	// Build entity model matrix: position + direction + scale
	var modelMat = mat4.create();
	mat4.identity(modelMat);

	var pos = entity.position;
	var scale = gpuModel.scale || 0.15;

	// Compute Y offset so the model's base sits at ground level.
	// roBrowser uses NEGATIVE world_y for "up" (world_y = -altitude), but
	// GLB models after skinning are in standard Y-up space (positive Y = up).
	// We negate the Y scale to flip the model right-side-up in roBrowser's
	// inverted coordinate system.
	//
	// With scale_y = -scale, a vertex at local py lands at:
	//   world_y = (-pos[2] + yOffset) + py * (-scale)
	// For the bottom (py = baseY) to land at ground (-pos[2]):
	//   yOffset = baseY * scale
	var yOffset = (gpuModel.baseY || 0) * scale;

	mat4.translate(modelMat, modelMat, [
		pos[0] + 0.5,
		-pos[2] + yOffset,
		pos[1] + 0.5
	]);

	// Rotate by entity direction (0-7, 45 degrees each)
	var dir = entity.direction || 0;
	var dirAngle = dir * (Math.PI / 4);
	mat4.rotateY(modelMat, modelMat, dirAngle);

	// Scale with Y negated to flip from standard Y-up to roBrowser's
	// inverted Y convention. CULL_FACE is disabled so winding flip is OK.
	// The normal matrix (inverse-transpose) correctly handles the flip.
	mat4.scale(modelMat, modelMat, [scale, -scale, scale]);

	// Camera matrices (same for all primitives)
	gl.uniformMatrix4fv(uniform.uProjectionMat, false, Camera.projection);
	gl.uniformMatrix4fv(uniform.uModelViewMat, false, Camera.modelView);

	// Lighting (same for all primitives)
	if (light) {
		if (light.direction) gl.uniform3fv(uniform.uLightDirection, light.direction);
		if (light.ambient) gl.uniform3fv(uniform.uLightAmbient, light.ambient);
		if (light.diffuse) gl.uniform3fv(uniform.uLightDiffuse, light.diffuse);
		if (light.env) gl.uniform3fv(uniform.uLightEnv, light.env);
	}

	// Fog
	var fogUse = fog && fog.use && fog.exist ? 1 : 0;
	gl.uniform1i(uniform.uFogUse, fogUse);
	if (fog) {
		gl.uniform1f(uniform.uFogNear, fog.near || 0);
		gl.uniform1f(uniform.uFogFar, fog.far || 500);
		if (fog.color) gl.uniform3fv(uniform.uFogColor, fog.color);
	}

	// Entity state
	if (entity.effectColor) {
		gl.uniform4fv(uniform.uEntityColor, entity.effectColor);
	} else {
		gl.uniform4f(uniform.uEntityColor, 1, 1, 1, 1);
	}
	var shadow = Ground.getShadowFactor(pos[0], pos[1]);
	gl.uniform1f(uniform.uShadowFactor, shadow);

	// Debug mode
	gl.uniform1i(uniform.uDebugMode, GLBRenderer.debugMode);

	// Skinning - use _getUniform helper for array uniform
	var jointLoc = _getUniform('uJointMatrices');
	if (jointMatrices && jointLoc) {
		gl.uniform1i(uniform.uUseSkinning, 1);
		gl.uniformMatrix4fv(jointLoc, false, jointMatrices);
	} else {
		gl.uniform1i(uniform.uUseSkinning, 0);
	}

	// Texture unit
	gl.activeTexture(gl.TEXTURE0);
	gl.uniform1i(uniform.uDiffuse, 0);

	// Comprehensive diagnostic dump on first frame
	if (_frameCount === 1) {
		var mv = Camera.modelView;
		var pr = Camera.projection;
		console.log('%c[GLBRenderer] === DIAGNOSTIC DUMP (frame 1) ===', 'color: #FF6600; font-weight: bold');
		console.log('[GLBRenderer] Entity pos=[' + pos[0].toFixed(2) + ',' + pos[1].toFixed(2) + ',' + pos[2].toFixed(2) + ']');
		console.log('[GLBRenderer] World translate=[' + (pos[0]+0.5).toFixed(2) + ',' + (-pos[2]).toFixed(2) + ',' + (pos[1]+0.5).toFixed(2) + ']');
		console.log('[GLBRenderer] Dir=' + dir + ' angle=' + (dirAngle * 180 / Math.PI).toFixed(1) + 'deg  Scale=' + scale);
		console.log('[GLBRenderer] BBox baseY=' + (gpuModel.baseY || 0).toFixed(2) +
			' yOffset=' + yOffset.toFixed(4) +
			(gpuModel.boundingBox ? ' restY=[' + gpuModel.boundingBox.min[1].toFixed(2) + ',' + gpuModel.boundingBox.max[1].toFixed(2) + ']' : '') +
			(gpuModel.skinnedBoundingBox ? ' skinnedY=[' + gpuModel.skinnedBoundingBox.min[1].toFixed(2) + ',' + gpuModel.skinnedBoundingBox.max[1].toFixed(2) + ']' : ' (no skinned bbox)'));
		console.log('[GLBRenderer] ModelMat diagonal=[' + modelMat[0].toFixed(4) + ',' + modelMat[5].toFixed(4) + ',' + modelMat[10].toFixed(4) + ',' + modelMat[15].toFixed(4) + ']');
		console.log('[GLBRenderer] ModelMat translate=[' + modelMat[12].toFixed(4) + ',' + modelMat[13].toFixed(4) + ',' + modelMat[14].toFixed(4) + ']');
		console.log('[GLBRenderer] Camera.projection[0..3]=[' + pr[0].toFixed(4) + ',' + pr[5].toFixed(4) + ',' + pr[10].toFixed(4) + ',' + pr[14].toFixed(4) + ']');
		console.log('[GLBRenderer] Camera.modelView row0=[' + mv[0].toFixed(4) + ',' + mv[4].toFixed(4) + ',' + mv[8].toFixed(4) + ',' + mv[12].toFixed(4) + ']');
		console.log('[GLBRenderer] Camera.modelView row1=[' + mv[1].toFixed(4) + ',' + mv[5].toFixed(4) + ',' + mv[9].toFixed(4) + ',' + mv[13].toFixed(4) + ']');
		console.log('[GLBRenderer] Camera.modelView row2=[' + mv[2].toFixed(4) + ',' + mv[6].toFixed(4) + ',' + mv[10].toFixed(4) + ',' + mv[14].toFixed(4) + ']');

		if (light) {
			console.log('[GLBRenderer] Light direction=[' +
				(light.direction ? light.direction[0].toFixed(3)+','+light.direction[1].toFixed(3)+','+light.direction[2].toFixed(3) : 'null') + ']');
			console.log('[GLBRenderer] Light ambient=[' +
				(light.ambient ? light.ambient[0].toFixed(3)+','+light.ambient[1].toFixed(3)+','+light.ambient[2].toFixed(3) : 'null') + ']');
			console.log('[GLBRenderer] Light diffuse=[' +
				(light.diffuse ? light.diffuse[0].toFixed(3)+','+light.diffuse[1].toFixed(3)+','+light.diffuse[2].toFixed(3) : 'null') + ']');
			console.log('[GLBRenderer] Light env=[' +
				(light.env ? light.env[0].toFixed(3)+','+light.env[1].toFixed(3)+','+light.env[2].toFixed(3) : 'null') + ']');
		} else {
			console.warn('[GLBRenderer] No light data!');
		}

		console.log('[GLBRenderer] Fog use=' + fogUse + ' near=' + (fog ? fog.near : 'N/A') + ' far=' + (fog ? fog.far : 'N/A'));
		console.log('[GLBRenderer] Shadow factor=' + shadow.toFixed(4));
		console.log('[GLBRenderer] Entity effectColor=[' +
			(entity.effectColor ? entity.effectColor[0].toFixed(2)+','+entity.effectColor[1].toFixed(2)+','+entity.effectColor[2].toFixed(2)+','+entity.effectColor[3].toFixed(2) : 'null') + ']');
		console.log('[GLBRenderer] Skinning=' + !!jointMatrices + (jointMatrices ? ' (' + jointMatrices.length/16 + ' joints)' : ''));
		console.log('[GLBRenderer] Debug mode=' + GLBRenderer.debugMode);

		if (jointMatrices) {
			// Log first joint matrix to verify it's not garbage
			console.log('[GLBRenderer] Joint[0] diagonal=[' +
				jointMatrices[0].toFixed(4) + ',' + jointMatrices[5].toFixed(4) + ',' +
				jointMatrices[10].toFixed(4) + ',' + jointMatrices[15].toFixed(4) + ']');
			// Check for NaN/Infinity
			var hasNaN = false;
			for (var k = 0; k < Math.min(jointMatrices.length, 256); k++) {
				if (isNaN(jointMatrices[k]) || !isFinite(jointMatrices[k])) { hasNaN = true; break; }
			}
			if (hasNaN) console.error('[GLBRenderer] !!! Joint matrices contain NaN/Infinity !!!');
		}

		// Test: compute a sample screen position for the entity center
		var testWorldPos = [pos[0] + 0.5, -pos[2], pos[1] + 0.5, 1.0];
		var viewPos = [0, 0, 0, 0];
		// Manual mat4*vec4
		for (var i = 0; i < 4; i++) {
			viewPos[i] = mv[i]*testWorldPos[0] + mv[i+4]*testWorldPos[1] + mv[i+8]*testWorldPos[2] + mv[i+12]*testWorldPos[3];
		}
		var clipPos = [0, 0, 0, 0];
		for (var i = 0; i < 4; i++) {
			clipPos[i] = pr[i]*viewPos[0] + pr[i+4]*viewPos[1] + pr[i+8]*viewPos[2] + pr[i+12]*viewPos[3];
		}
		var ndcX = clipPos[0] / clipPos[3];
		var ndcY = clipPos[1] / clipPos[3];
		var ndcZ = clipPos[2] / clipPos[3];
		console.log('[GLBRenderer] Entity center: view=[' + viewPos[0].toFixed(2) + ',' + viewPos[1].toFixed(2) + ',' + viewPos[2].toFixed(2) + ']' +
			' clip=[' + clipPos[0].toFixed(2) + ',' + clipPos[1].toFixed(2) + ',' + clipPos[2].toFixed(2) + ',' + clipPos[3].toFixed(2) + ']' +
			' ndc=[' + ndcX.toFixed(3) + ',' + ndcY.toFixed(3) + ',' + ndcZ.toFixed(3) + ']');
		if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) {
			console.warn('[GLBRenderer] !!! Entity center is OFF SCREEN !!!');
		}
		if (ndcZ < -1 || ndcZ > 1) {
			console.warn('[GLBRenderer] !!! Entity center is OUTSIDE depth range (behind camera or beyond far plane) !!!');
		}

		// Log primitive info
		for (var pp = 0; pp < gpuModel.primitives.length; pp++) {
			var ppp = gpuModel.primitives[pp];
			console.log('[GLBRenderer] Prim[' + pp + '] mesh="' + (ppp.meshName || '?') + '" mat="' + (ppp.materialName || '?') + '":' +
				' verts=' + ppp.vertexCount +
				' indices=' + (ppp.hasIndices ? ppp.indexCount : 'none') +
				' skinning=' + ppp.hasSkinning +
				' texture=' + (ppp.texture === _whiteTexture ? 'WHITE_FALLBACK' : 'loaded') +
				' baseColor=[' + ppp.baseColorFactor[0].toFixed(2) + ',' + ppp.baseColorFactor[1].toFixed(2) + ',' + ppp.baseColorFactor[2].toFixed(2) + ',' + ppp.baseColorFactor[3].toFixed(2) + ']' +
				' nodeTransform=' + (ppp.nodeTransform ? 'yes' : 'none'));
		}

		console.log('%c[GLBRenderer] === END DIAGNOSTIC ===', 'color: #FF6600; font-weight: bold');
		console.log('%c[GLBRenderer] TIP: Set GLBRenderer.debugMode=1 in console for flat red render test', 'color: #2196F3');
	}

	// Guild flag emblem: check if this entity is a guild flag with an emblem
	var emblemTex = null;
	var isGuildFlag = entity._glbConfig && entity._glbConfig.isGuildFlag;
	if (isGuildFlag) {
		emblemTex = this._getEmblemTexture(gl, entity);
	}

	// Scratch matrices for per-primitive node transform
	var finalMat = mat4.create();
	var normalMat = mat3.create();

	// Draw each primitive
	for (var p = 0; p < gpuModel.primitives.length; p++) {
		var prim = gpuModel.primitives[p];

		// Guild flag: the emblem plane (material name contains "emblem") is
		// hidden by default. It only renders when a guild emblem is available.
		var isEmblemPlane = prim.materialName.toLowerCase().indexOf('emblem') !== -1;
		if (isGuildFlag && isEmblemPlane && !emblemTex) {
			continue; // Skip emblem plane when no guild emblem
		}

		// Compute final model matrix: entity transform * node transform
		// For non-skinned meshes, the glTF node hierarchy may include transforms
		// (scale, rotation, translation) that must be applied.
		if (prim.nodeTransform) {
			mat4.multiply(finalMat, modelMat, prim.nodeTransform);
		} else {
			mat4.copy(finalMat, modelMat);
		}

		// Set model matrix and corresponding normal matrix per-primitive
		gl.uniformMatrix4fv(uniform.uModelMat, false, finalMat);
		mat3.fromMat4(normalMat, finalMat);
		mat3.invert(normalMat, normalMat);
		mat3.transpose(normalMat, normalMat);
		gl.uniformMatrix3fv(uniform.uNormalMat, false, normalMat);

		gl.uniform4fv(uniform.uBaseColorFactor, prim.baseColorFactor);

		// Guild flag: replace the emblem plane's texture with the guild emblem.
		if (isGuildFlag && isEmblemPlane && emblemTex) {
			gl.bindTexture(gl.TEXTURE_2D, emblemTex);
		} else {
			gl.bindTexture(gl.TEXTURE_2D, prim.texture);
		}

		gl.bindVertexArray(prim.vao);
		if (prim.hasIndices) {
			gl.drawElements(gl.TRIANGLES, prim.indexCount, prim.indexType, 0);
		} else {
			gl.drawArrays(gl.TRIANGLES, 0, prim.vertexCount);
		}
	}

	gl.bindVertexArray(null);
};

/**
 * Free GPU resources for a single mesh handle
 */
GLBRenderer.freeMesh = function freeMesh(gl, gpuHandle) {
	if (!gpuHandle) return;

	for (var i = 0; i < gpuHandle.primitives.length; i++) {
		var prim = gpuHandle.primitives[i];
		gl.deleteVertexArray(prim.vao);
		for (var b = 0; b < prim.buffers.length; b++) {
			gl.deleteBuffer(prim.buffers[b]);
		}
	}

	for (var t = 0; t < gpuHandle.textures.length; t++) {
		if (gpuHandle.textures[t]) {
			gl.deleteTexture(gpuHandle.textures[t]);
		}
	}
};

/**
 * Free all renderer resources
 */
GLBRenderer.free = function free(gl) {
	if (_program) {
		gl.deleteProgram(_program);
		_program = null;
	}
	if (_whiteTexture) {
		gl.deleteTexture(_whiteTexture);
		_whiteTexture = null;
	}
	// Clean up emblem textures
	for (var gid in _emblemTextures) {
		if (_emblemTextures.hasOwnProperty(gid) && _emblemTextures[gid].texture) {
			gl.deleteTexture(_emblemTextures[gid].texture);
		}
	}
	_emblemTextures = {};
};

export default GLBRenderer;
