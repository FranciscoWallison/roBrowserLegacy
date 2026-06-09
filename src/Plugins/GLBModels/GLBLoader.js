/**
 * Plugins/GLBModels/GLBLoader.js
 *
 * Minimal glTF Binary (GLB) parser.
 * Parses the GLB container and extracts meshes, materials, skins, animations,
 * and textures without any external dependencies (no Three.js).
 *
 * Reference: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html
 */
var GLBLoader = {};

// glTF constants
var GLB_MAGIC = 0x46546C67; // 'glTF'
var CHUNK_TYPE_JSON = 0x4E4F534A;
var CHUNK_TYPE_BIN = 0x004E4942;

var COMPONENT_TYPES = {
	5120: Int8Array,
	5121: Uint8Array,
	5122: Int16Array,
	5123: Uint16Array,
	5125: Uint32Array,
	5126: Float32Array
};

var TYPE_SIZES = {
	SCALAR: 1,
	VEC2: 2,
	VEC3: 3,
	VEC4: 4,
	MAT2: 4,
	MAT3: 9,
	MAT4: 16
};

/**
 * Parse a GLB ArrayBuffer into structured data
 *
 * @param {ArrayBuffer} arrayBuffer
 * @returns {object} { json, bin, meshes, materials, nodes, skins, animations, images }
 */
GLBLoader.parse = function parse(arrayBuffer) {
	var dv = new DataView(arrayBuffer);
	var offset = 0;

	// Header: magic(4) + version(4) + length(4) = 12 bytes
	var magic = dv.getUint32(offset, true);
	offset += 4;
	if (magic !== GLB_MAGIC) {
		throw new Error('[GLBLoader] Invalid GLB magic: 0x' + magic.toString(16));
	}

	var version = dv.getUint32(offset, true);
	offset += 4;
	if (version !== 2) {
		throw new Error('[GLBLoader] Unsupported glTF version: ' + version);
	}

	var totalLength = dv.getUint32(offset, true);
	offset += 4;

	// Parse chunks
	var json = null;
	var bin = null;

	while (offset < totalLength) {
		var chunkLength = dv.getUint32(offset, true);
		offset += 4;
		var chunkType = dv.getUint32(offset, true);
		offset += 4;

		if (chunkType === CHUNK_TYPE_JSON) {
			var jsonBytes = new Uint8Array(arrayBuffer, offset, chunkLength);
			var jsonStr = '';
			// Decode UTF-8
			for (var i = 0; i < jsonBytes.length; i++) {
				jsonStr += String.fromCharCode(jsonBytes[i]);
			}
			json = JSON.parse(jsonStr);
		} else if (chunkType === CHUNK_TYPE_BIN) {
			bin = arrayBuffer.slice(offset, offset + chunkLength);
		}

		offset += chunkLength;
	}

	if (!json) {
		throw new Error('[GLBLoader] No JSON chunk found');
	}

	// Build result
	var result = {
		json: json,
		bin: bin,
		meshes: [],
		materials: [],
		nodes: [],
		skins: [],
		animations: [],
		images: []
	};

	// Parse nodes (with parent references)
	this._parseNodes(json, result);

	// Parse materials
	this._parseMaterials(json, result);

	// Parse images/textures
	this._parseImages(json, bin, result);

	// Parse meshes
	this._parseMeshes(json, bin, result);

	// Parse skins
	this._parseSkins(json, bin, result);

	// Parse animations
	this._parseAnimations(json, bin, result);

	return result;
};

/**
 * Parse node hierarchy
 */
GLBLoader._parseNodes = function (json, result) {
	if (!json.nodes) return;

	for (var i = 0; i < json.nodes.length; i++) {
		var src = json.nodes[i];
		result.nodes.push({
			name: src.name || ('node_' + i),
			translation: src.translation ? new Float32Array(src.translation) : new Float32Array([0, 0, 0]),
			rotation: src.rotation ? new Float32Array(src.rotation) : new Float32Array([0, 0, 0, 1]),
			scale: src.scale ? new Float32Array(src.scale) : new Float32Array([1, 1, 1]),
			matrix: src.matrix ? new Float32Array(src.matrix) : null,
			children: src.children || [],
			mesh: src.mesh !== undefined ? src.mesh : -1,
			skin: src.skin !== undefined ? src.skin : -1,
			parent: -1
		});
	}

	// Resolve parent references
	for (var i = 0; i < result.nodes.length; i++) {
		var children = result.nodes[i].children;
		for (var c = 0; c < children.length; c++) {
			if (children[c] < result.nodes.length) {
				result.nodes[children[c]].parent = i;
			}
		}
	}
};

/**
 * Parse materials
 */
GLBLoader._parseMaterials = function (json, result) {
	if (!json.materials) return;

	for (var i = 0; i < json.materials.length; i++) {
		var src = json.materials[i];
		var pbr = src.pbrMetallicRoughness || {};
		result.materials.push({
			name: src.name || ('material_' + i),
			baseColorFactor: pbr.baseColorFactor
				? new Float32Array(pbr.baseColorFactor)
				: new Float32Array([1, 1, 1, 1]),
			baseColorTextureIndex: pbr.baseColorTexture
				? pbr.baseColorTexture.index
				: -1,
			doubleSided: !!src.doubleSided,
			alphaMode: src.alphaMode || 'OPAQUE',
			alphaCutoff: src.alphaCutoff !== undefined ? src.alphaCutoff : 0.5
		});
	}
};

/**
 * Parse embedded images from the BIN chunk
 */
GLBLoader._parseImages = function (json, bin, result) {
	if (!json.images) return;

	for (var i = 0; i < json.images.length; i++) {
		var src = json.images[i];
		var imageData = null;

		if (src.bufferView !== undefined && bin) {
			var bv = json.bufferViews[src.bufferView];
			var byteOffset = bv.byteOffset || 0;
			imageData = new Uint8Array(bin, byteOffset, bv.byteLength);
		}

		result.images.push({
			name: src.name || ('image_' + i),
			mimeType: src.mimeType || 'image/png',
			data: imageData
		});
	}
};

/**
 * Parse mesh primitives
 */
GLBLoader._parseMeshes = function (json, bin, result) {
	if (!json.meshes) return;

	for (var m = 0; m < json.meshes.length; m++) {
		var srcMesh = json.meshes[m];
		var mesh = {
			name: srcMesh.name || ('mesh_' + m),
			primitives: []
		};

		for (var p = 0; p < srcMesh.primitives.length; p++) {
			var srcPrim = srcMesh.primitives[p];
			var prim = {
				positions: null,
				normals: null,
				texcoords: null,
				indices: null,
				joints: null,
				weights: null,
				materialIndex: srcPrim.material !== undefined ? srcPrim.material : -1,
				mode: srcPrim.mode !== undefined ? srcPrim.mode : 4 // TRIANGLES
			};

			// Attributes
			var attrs = srcPrim.attributes;
			if (attrs.POSITION !== undefined) {
				prim.positions = this._readAccessor(json, bin, attrs.POSITION);
			}
			if (attrs.NORMAL !== undefined) {
				prim.normals = this._readAccessor(json, bin, attrs.NORMAL);
			}
			if (attrs.TEXCOORD_0 !== undefined) {
				prim.texcoords = this._readAccessor(json, bin, attrs.TEXCOORD_0);
			}
			if (attrs.JOINTS_0 !== undefined) {
				prim.joints = this._readAccessor(json, bin, attrs.JOINTS_0);
			}
			if (attrs.WEIGHTS_0 !== undefined) {
				prim.weights = this._readAccessor(json, bin, attrs.WEIGHTS_0);
			}

			// Indices (must be parsed before flat normal generation)
			if (srcPrim.indices !== undefined) {
				prim.indices = this._readAccessor(json, bin, srcPrim.indices);
			}

			// Generate flat normals if missing (after indices so normals are correct for indexed meshes)
			if (!prim.normals && prim.positions) {
				prim.normals = this._generateFlatNormals(prim.positions, prim.indices);
			}

			mesh.primitives.push(prim);
		}

		result.meshes.push(mesh);
	}
};

/**
 * Parse skin data (joints + inverse bind matrices)
 */
GLBLoader._parseSkins = function (json, bin, result) {
	if (!json.skins) return;

	for (var i = 0; i < json.skins.length; i++) {
		var src = json.skins[i];
		var skin = {
			name: src.name || ('skin_' + i),
			joints: src.joints || [],
			inverseBindMatrices: null,
			skeleton: src.skeleton !== undefined ? src.skeleton : -1
		};

		if (src.inverseBindMatrices !== undefined) {
			skin.inverseBindMatrices = this._readAccessor(json, bin, src.inverseBindMatrices);
		}

		result.skins.push(skin);
	}
};

/**
 * Parse animations
 */
GLBLoader._parseAnimations = function (json, bin, result) {
	if (!json.animations) return;

	for (var a = 0; a < json.animations.length; a++) {
		var srcAnim = json.animations[a];
		var anim = {
			name: srcAnim.name || ('animation_' + a),
			duration: 0,
			channels: []
		};

		// Parse samplers first
		var samplers = [];
		for (var s = 0; s < srcAnim.samplers.length; s++) {
			var srcSampler = srcAnim.samplers[s];
			samplers.push({
				interpolation: srcSampler.interpolation || 'LINEAR',
				times: this._readAccessor(json, bin, srcSampler.input),
				values: this._readAccessor(json, bin, srcSampler.output)
			});
		}

		// Parse channels
		for (var c = 0; c < srcAnim.channels.length; c++) {
			var srcChannel = srcAnim.channels[c];
			var sampler = samplers[srcChannel.sampler];
			var channel = {
				targetNode: srcChannel.target.node,
				path: srcChannel.target.path, // 'translation', 'rotation', 'scale'
				interpolation: sampler.interpolation,
				times: sampler.times,
				values: sampler.values
			};
			anim.channels.push(channel);

			// Track max duration
			if (sampler.times && sampler.times.length > 0) {
				var maxTime = sampler.times[sampler.times.length - 1];
				if (maxTime > anim.duration) {
					anim.duration = maxTime;
				}
			}
		}

		result.animations.push(anim);
	}
};

/**
 * Read an accessor from the binary buffer
 *
 * @param {object} json - glTF JSON
 * @param {ArrayBuffer} bin - binary buffer
 * @param {number} accessorIndex
 * @returns {TypedArray}
 */
GLBLoader._readAccessor = function (json, bin, accessorIndex) {
	var accessor = json.accessors[accessorIndex];
	var bufferView = json.bufferViews[accessor.bufferView];
	var TypedArrayClass = COMPONENT_TYPES[accessor.componentType];

	if (!TypedArrayClass) {
		console.warn('[GLBLoader] Unknown component type:', accessor.componentType);
		return null;
	}

	var typeSize = TYPE_SIZES[accessor.type] || 1;
	var elementCount = accessor.count * typeSize;
	var byteOffset = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);

	// Handle stride (interleaved buffers)
	var byteStride = bufferView.byteStride || 0;
	var elementByteSize = TypedArrayClass.BYTES_PER_ELEMENT * typeSize;

	var rawData;
	if (byteStride && byteStride !== elementByteSize) {
		// Interleaved: copy elements one by one
		rawData = new TypedArrayClass(elementCount);
		var srcView = new DataView(bin);
		for (var i = 0; i < accessor.count; i++) {
			var srcOffset = byteOffset + i * byteStride;
			for (var j = 0; j < typeSize; j++) {
				var val;
				switch (accessor.componentType) {
					case 5126:
						val = srcView.getFloat32(srcOffset + j * 4, true);
						break;
					case 5123:
						val = srcView.getUint16(srcOffset + j * 2, true);
						break;
					case 5125:
						val = srcView.getUint32(srcOffset + j * 4, true);
						break;
					case 5121:
						val = srcView.getUint8(srcOffset + j);
						break;
					case 5122:
						val = srcView.getInt16(srcOffset + j * 2, true);
						break;
					case 5120:
						val = srcView.getInt8(srcOffset + j);
						break;
					default:
						val = 0;
				}
				rawData[i * typeSize + j] = val;
			}
		}
	} else {
		// Contiguous: direct typed array view
		rawData = new TypedArrayClass(bin, byteOffset, elementCount);
	}

	// Handle normalized accessors (glTF spec: integer values mapped to [0,1] or [-1,1])
	// Critical for WEIGHTS_0 which is often stored as normalized Uint8 or Uint16.
	if (accessor.normalized && accessor.componentType !== 5126) {
		var floatData = new Float32Array(elementCount);
		var divisor;
		switch (accessor.componentType) {
			case 5121: divisor = 255.0; break;     // Uint8
			case 5123: divisor = 65535.0; break;   // Uint16
			case 5120: divisor = 127.0; break;     // Int8
			case 5122: divisor = 32767.0; break;   // Int16
			default: divisor = 1.0;
		}
		var isSigned = (accessor.componentType === 5120 || accessor.componentType === 5122);
		for (var n = 0; n < elementCount; n++) {
			var normalized = rawData[n] / divisor;
			floatData[n] = isSigned ? Math.max(normalized, -1.0) : normalized;
		}
		return floatData;
	}

	return rawData;
};

/**
 * Generate flat normals from positions and indices
 *
 * @param {Float32Array} positions
 * @param {TypedArray|null} indices
 * @returns {Float32Array}
 */
GLBLoader._generateFlatNormals = function (positions, indices) {
	var vertCount = positions.length / 3;
	var normals = new Float32Array(positions.length);
	var triCount = indices ? indices.length / 3 : vertCount / 3;

	for (var t = 0; t < triCount; t++) {
		var i0 = indices ? indices[t * 3] : t * 3;
		var i1 = indices ? indices[t * 3 + 1] : t * 3 + 1;
		var i2 = indices ? indices[t * 3 + 2] : t * 3 + 2;

		var ax = positions[i1 * 3] - positions[i0 * 3];
		var ay = positions[i1 * 3 + 1] - positions[i0 * 3 + 1];
		var az = positions[i1 * 3 + 2] - positions[i0 * 3 + 2];
		var bx = positions[i2 * 3] - positions[i0 * 3];
		var by = positions[i2 * 3 + 1] - positions[i0 * 3 + 1];
		var bz = positions[i2 * 3 + 2] - positions[i0 * 3 + 2];

		var nx = ay * bz - az * by;
		var ny = az * bx - ax * bz;
		var nz = ax * by - ay * bx;
		var len = Math.sqrt(nx * nx + ny * ny + nz * nz);
		if (len > 0) {
			nx /= len;
			ny /= len;
			nz /= len;
		}

		normals[i0 * 3] += nx;
		normals[i0 * 3 + 1] += ny;
		normals[i0 * 3 + 2] += nz;
		normals[i1 * 3] += nx;
		normals[i1 * 3 + 1] += ny;
		normals[i1 * 3 + 2] += nz;
		normals[i2 * 3] += nx;
		normals[i2 * 3 + 1] += ny;
		normals[i2 * 3 + 2] += nz;
	}

	// Normalize
	for (var i = 0; i < vertCount; i++) {
		var x = normals[i * 3];
		var y = normals[i * 3 + 1];
		var z = normals[i * 3 + 2];
		var l = Math.sqrt(x * x + y * y + z * z);
		if (l > 0) {
			normals[i * 3] /= l;
			normals[i * 3 + 1] /= l;
			normals[i * 3 + 2] /= l;
		}
	}

	return normals;
};

/**
 * Merge a single bone action animation into a main model's parsed data.
 *
 * Each bone file (e.g. 8_attack.glb) contains one animation for a specific action.
 * The animation is renamed to the action name (attack, move, damage, dead)
 * regardless of whatever name it has inside the GLB.
 *
 * If the main model has no skins but the bone file does, the skin data
 * is also copied over (joints, inverse bind matrices).
 *
 * @param {object} mainParsed - parsed GLB data from the main model
 * @param {object} boneParsed - parsed GLB data from the bone action file
 * @param {string} actionName - action name derived from filename ('attack', 'move', 'damage', 'dead')
 */
GLBLoader.mergeBoneAction = function mergeBoneAction(mainParsed, boneParsed, actionName) {
	if (!boneParsed.animations || boneParsed.animations.length === 0) {
		return;
	}

	// Check if this action already exists (avoid duplicates)
	var actionLower = actionName.toLowerCase();
	for (var i = 0; i < mainParsed.animations.length; i++) {
		if (mainParsed.animations[i].name.toLowerCase() === actionLower) {
			return; // Already have this action
		}
	}

	// If main model has no skeleton but bone file does, adopt the skeleton
	if ((!mainParsed.skins || mainParsed.skins.length === 0) &&
		boneParsed.skins && boneParsed.skins.length > 0) {
		mainParsed.skins = boneParsed.skins;
	}

	// If main model has fewer nodes than bone file (bone file has full skeleton),
	// adopt the bone file's node hierarchy while preserving mesh references
	if (boneParsed.nodes.length > mainParsed.nodes.length) {
		var mainMeshNodes = [];
		for (var i = 0; i < mainParsed.nodes.length; i++) {
			if (mainParsed.nodes[i].mesh >= 0) {
				mainMeshNodes.push({
					index: i,
					node: mainParsed.nodes[i]
				});
			}
		}

		mainParsed.nodes = boneParsed.nodes;

		for (var i = 0; i < mainMeshNodes.length; i++) {
			var entry = mainMeshNodes[i];
			if (entry.index < mainParsed.nodes.length) {
				mainParsed.nodes[entry.index].mesh = entry.node.mesh;
				mainParsed.nodes[entry.index].skin = entry.node.skin;
			}
		}
	}

	// Take the first animation from the bone file and rename it to the action name
	var boneAnim = boneParsed.animations[0];
	var mergedAnim = {
		name: actionName,
		duration: boneAnim.duration,
		channels: boneAnim.channels
	};

	mainParsed.animations.push(mergedAnim);
};

export default GLBLoader;
