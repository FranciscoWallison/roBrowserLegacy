#version 300 es
precision highp float;

// Attributes
in vec3 aPosition;
in vec3 aNormal;
in vec2 aTexCoord;
in vec4 aJoints;
in vec4 aWeights;

// Transform uniforms
uniform mat4 uProjectionMat;
uniform mat4 uModelViewMat;
uniform mat4 uModelMat;
uniform mat3 uNormalMat;

// Skinning uniforms
uniform bool uUseSkinning;
uniform mat4 uJointMatrices[64];

// Varyings
out vec2 vTexCoord;
out vec3 vNormal;
out vec3 vWorldPos;

void main() {
	vec4 pos = vec4(aPosition, 1.0);
	vec3 norm = aNormal;

	// Skeletal skinning
	if (uUseSkinning) {
		ivec4 j = ivec4(aJoints);
		mat4 skinMat = aWeights.x * uJointMatrices[j.x]
		             + aWeights.y * uJointMatrices[j.y]
		             + aWeights.z * uJointMatrices[j.z]
		             + aWeights.w * uJointMatrices[j.w];
		pos = skinMat * pos;
		norm = mat3(skinMat) * norm;
	}

	// World transform (entity position + direction rotation + scale)
	vec4 worldPos = uModelMat * pos;

	// View + projection transform
	gl_Position = uProjectionMat * uModelViewMat * worldPos;

	// Normal in world space for lighting
	vNormal = normalize(uNormalMat * norm);
	vTexCoord = aTexCoord;
	vWorldPos = worldPos.xyz;
}
