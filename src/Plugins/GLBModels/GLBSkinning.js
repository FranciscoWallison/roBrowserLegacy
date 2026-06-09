/**
 * Plugins/GLBModels/GLBSkinning.js
 *
 * Skeletal animation evaluator for GLB models.
 * Computes joint matrices from animation clips at a given time.
 * Uses the same SLERP/LERP interpolation approach as AnimatedModels.js.
 */
import glMatrix from 'Utils/gl-matrix.js';

var mat4 = glMatrix.mat4;
var vec3 = glMatrix.vec3;
var quat = glMatrix.quat;

var GLBSkinning = {};

// Scratch matrices to avoid GC pressure (same pattern as AnimatedModels.js)
var _tempMat4 = mat4.create();
var _tempQuat = quat.create();
var _tempVec3 = vec3.create();

/**
 * Compute joint matrices for a skin at a given animation time.
 *
 * @param {object} parsedGLB - parsed GLB data
 * @param {number} skinIndex - which skin to use (usually 0)
 * @param {object} animClip - animation clip from parsedGLB.animations[]
 * @param {number} time - current time in seconds
 * @returns {Float32Array} flat array of mat4 (jointCount * 16 floats)
 */
/**
 * Compute joint matrices for the bind pose (no animation applied).
 * Uses the default node TRS values from the GLB file, giving the
 * model its original rest position (e.g. flag straight, not waving).
 *
 * @param {object} parsedGLB - parsed GLB data
 * @param {number} skinIndex - which skin to use (usually 0)
 * @returns {Float32Array} flat array of mat4 (jointCount * 16 floats)
 */
GLBSkinning.computeBindPoseMatrices = function computeBindPoseMatrices(parsedGLB, skinIndex) {
	var skin = parsedGLB.skins[skinIndex];
	if (!skin) return null;

	var nodes = parsedGLB.nodes;
	var jointCount = skin.joints.length;
	if (jointCount > 64) jointCount = 64;

	var result = new Float32Array(jointCount * 16);

	// Build local transforms from default node TRS (no animation channels)
	var localTransforms = new Array(nodes.length);
	for (var i = 0; i < nodes.length; i++) {
		localTransforms[i] = {
			translation: vec3.clone(nodes[i].translation),
			rotation: quat.clone(nodes[i].rotation),
			scale: vec3.clone(nodes[i].scale),
			animated: false
		};
	}

	var globalTransforms = this._computeGlobalTransforms(nodes, localTransforms);

	for (var j = 0; j < jointCount; j++) {
		var nodeIndex = skin.joints[j];
		var ibmOffset = j * 16;

		if (skin.inverseBindMatrices) {
			var ibm = skin.inverseBindMatrices.subarray(ibmOffset, ibmOffset + 16);
			mat4.multiply(_tempMat4, globalTransforms[nodeIndex], ibm);
		} else {
			mat4.copy(_tempMat4, globalTransforms[nodeIndex]);
		}

		result.set(_tempMat4, j * 16);
	}

	return result;
};

GLBSkinning.computeJointMatrices = function computeJointMatrices(parsedGLB, skinIndex, animClip, time) {
	var skin = parsedGLB.skins[skinIndex];
	if (!skin) return null;

	var nodes = parsedGLB.nodes;
	var jointCount = skin.joints.length;

	// Cap to shader limit
	if (jointCount > 64) {
		jointCount = 64;
	}

	var result = new Float32Array(jointCount * 16);

	// 1. Evaluate animation channels to get local TRS for each node
	var localTransforms = this._evaluateAnimation(animClip, time, nodes);

	// 2. Compute global transforms by walking node hierarchy
	var globalTransforms = this._computeGlobalTransforms(nodes, localTransforms);

	// 3. Multiply by inverse bind matrices to get final joint matrices
	for (var j = 0; j < jointCount; j++) {
		var nodeIndex = skin.joints[j];
		var ibmOffset = j * 16;

		// Get inverse bind matrix (or identity if missing)
		if (skin.inverseBindMatrices) {
			var ibm = skin.inverseBindMatrices.subarray(ibmOffset, ibmOffset + 16);
			mat4.multiply(_tempMat4, globalTransforms[nodeIndex], ibm);
		} else {
			mat4.copy(_tempMat4, globalTransforms[nodeIndex]);
		}

		result.set(_tempMat4, j * 16);
	}

	return result;
};

/**
 * Evaluate animation channels at a specific time.
 * Returns local TRS transforms for each node.
 *
 * @param {object} clip - animation clip
 * @param {number} time - time in seconds
 * @param {Array} nodes - node array from parsed GLB
 * @returns {Array} array of { translation, rotation, scale } per node
 */
GLBSkinning._evaluateAnimation = function _evaluateAnimation(clip, time, nodes) {
	// Loop time
	var t = clip.duration > 0 ? (time % clip.duration) : 0;

	// Start with default node TRS
	var transforms = new Array(nodes.length);
	for (var i = 0; i < nodes.length; i++) {
		transforms[i] = {
			translation: vec3.clone(nodes[i].translation),
			rotation: quat.clone(nodes[i].rotation),
			scale: vec3.clone(nodes[i].scale),
			animated: false // track if any channel modifies this node
		};
	}

	// Apply animation channels
	if (!clip.channels) return transforms;

	for (var c = 0; c < clip.channels.length; c++) {
		var ch = clip.channels[c];
		if (ch.targetNode >= nodes.length) continue;

		var value = this._sampleChannel(ch, t);
		if (!value) continue;

		var tr = transforms[ch.targetNode];
		tr.animated = true;
		switch (ch.path) {
			case 'translation':
				vec3.copy(tr.translation, value);
				break;
			case 'rotation':
				quat.copy(tr.rotation, value);
				break;
			case 'scale':
				vec3.copy(tr.scale, value);
				break;
		}
	}

	return transforms;
};

/**
 * Sample an animation channel at time t using binary search + interpolation.
 * Same approach as AnimatedModels.js getRotationAtFrame / getPositionAtFrame.
 *
 * @param {object} channel - { times, values, path, interpolation }
 * @param {number} t - time in seconds
 * @returns {Float32Array|null} interpolated value
 */
GLBSkinning._sampleChannel = function _sampleChannel(channel, t) {
	var times = channel.times;
	var values = channel.values;
	if (!times || times.length === 0) return null;

	var stride = channel.path === 'rotation' ? 4 : 3;

	// Clamp to range
	if (t <= times[0]) {
		return values.subarray(0, stride);
	}
	if (t >= times[times.length - 1]) {
		var lastOffset = (times.length - 1) * stride;
		return values.subarray(lastOffset, lastOffset + stride);
	}

	// Binary search for the interval containing t
	var lo = 0;
	var hi = times.length - 1;
	while (lo < hi - 1) {
		var mid = (lo + hi) >> 1;
		if (times[mid] <= t) {
			lo = mid;
		} else {
			hi = mid;
		}
	}

	// Interpolation factor
	var frac = (t - times[lo]) / (times[hi] - times[lo]);
	var aOffset = lo * stride;
	var bOffset = hi * stride;

	if (stride === 4) {
		// SLERP for quaternion rotation
		var qa = values.subarray(aOffset, aOffset + 4);
		var qb = values.subarray(bOffset, bOffset + 4);
		quat.slerp(_tempQuat, qa, qb, frac);
		return _tempQuat;
	} else {
		// LERP for translation/scale
		var va = values.subarray(aOffset, aOffset + 3);
		var vb = values.subarray(bOffset, bOffset + 3);
		vec3.lerp(_tempVec3, va, vb, frac);
		return _tempVec3;
	}
};

/**
 * Compute global transforms by walking the node hierarchy.
 * Each node's global transform = parent global * local TRS.
 *
 * @param {Array} nodes - node array from parsed GLB
 * @param {Array} localTransforms - TRS per node
 * @returns {Array} array of mat4 global transforms
 */
GLBSkinning._computeGlobalTransforms = function _computeGlobalTransforms(nodes, localTransforms) {
	var globals = new Array(nodes.length);

	function compute(nodeIndex) {
		if (globals[nodeIndex]) return globals[nodeIndex];

		// Build local matrix from TRS
		var local = mat4.create();
		var lt = localTransforms[nodeIndex];

		// Use the static matrix ONLY if:
		// 1. The node has a matrix property AND
		// 2. No animation channels modified this node's TRS
		// This ensures animations override static matrices correctly.
		if (nodes[nodeIndex].matrix && !lt.animated) {
			mat4.copy(local, nodes[nodeIndex].matrix);
		} else {
			// Build TRS matrix: T * R * S
			// gl-matrix v2 doesn't have fromRotationTranslationScale,
			// so we compose it manually
			mat4.fromRotationTranslation(local, lt.rotation, lt.translation);
			mat4.scale(local, local, lt.scale);
		}

		var parentIndex = nodes[nodeIndex].parent;
		if (parentIndex >= 0) {
			var parentGlobal = compute(parentIndex);
			globals[nodeIndex] = mat4.create();
			mat4.multiply(globals[nodeIndex], parentGlobal, local);
		} else {
			globals[nodeIndex] = local;
		}
		return globals[nodeIndex];
	}

	for (var i = 0; i < nodes.length; i++) {
		compute(i);
	}

	return globals;
};

export default GLBSkinning;
