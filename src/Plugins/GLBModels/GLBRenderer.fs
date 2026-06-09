#version 300 es
precision highp float;

in vec2 vTexCoord;
in vec3 vNormal;
in vec3 vWorldPos;
out vec4 fragColor;

// Material
uniform sampler2D uDiffuse;
uniform vec4 uBaseColorFactor;

// Entity state
uniform vec4 uEntityColor;
uniform float uShadowFactor;

// Lighting (matches roBrowser Models.fs pattern)
uniform vec3 uLightDirection;
uniform vec3 uLightAmbient;
uniform vec3 uLightDiffuse;
uniform vec3 uLightEnv;

// Fog (matches roBrowser fog system)
uniform bool uFogUse;
uniform float uFogNear;
uniform float uFogFar;
uniform vec3 uFogColor;

// Debug mode: 0=normal, 1=flat red, 2=normals, 3=UVs, 4=depth, 5=unlit texture
uniform int uDebugMode;

void main() {
	// Debug mode 1: flat bright red - tests if geometry reaches the screen at all
	if (uDebugMode == 1) {
		fragColor = vec4(1.0, 0.0, 0.0, 1.0);
		return;
	}

	// Debug mode 2: visualize normals as colors
	if (uDebugMode == 2) {
		vec3 n = normalize(vNormal) * 0.5 + 0.5;
		fragColor = vec4(n, 1.0);
		return;
	}

	// Debug mode 3: visualize texture coordinates
	if (uDebugMode == 3) {
		fragColor = vec4(vTexCoord, 0.0, 1.0);
		return;
	}

	// Debug mode 4: visualize depth
	if (uDebugMode == 4) {
		float d = gl_FragCoord.z;
		fragColor = vec4(d, d, d, 1.0);
		return;
	}

	// Debug mode 5: texture only, no lighting/fog
	if (uDebugMode == 5) {
		vec4 tex = texture(uDiffuse, vTexCoord) * uBaseColorFactor;
		if (tex.a < 0.01) discard;
		fragColor = tex;
		return;
	}

	vec4 tex = texture(uDiffuse, vTexCoord) * uBaseColorFactor;

	// Alpha discard
	if (tex.a < 0.01) {
		discard;
	}

	// Directional lighting (same model as Models.fs)
	float NdotL = max(dot(normalize(vNormal), uLightDirection), 0.0);
	vec3 light = NdotL * uLightDiffuse + uLightAmbient;
	tex.rgb *= clamp(light, 0.0, 1.0);
	tex.rgb *= clamp(uLightEnv, 0.0, 1.0);

	// Shadow factor from ground
	tex.rgb *= uShadowFactor;

	// Entity color modulation (tint, transparency, effects)
	tex *= uEntityColor;

	fragColor = tex;

	// Fog (same as roBrowser's existing fog)
	if (uFogUse) {
		float depth = gl_FragCoord.z / gl_FragCoord.w;
		float fogFactor = smoothstep(uFogNear, uFogFar, depth);
		fragColor = mix(fragColor, vec4(uFogColor, fragColor.w), fogFactor);
	}
}
