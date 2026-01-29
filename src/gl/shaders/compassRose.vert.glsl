#version 330 core
layout (location = 0) in vec3 aPos;
layout (location = 1) in vec4 aColor;
layout (location = 2) in vec3 aNormal;

uniform highp mat4 uModelMatrix;
uniform highp mat4 uViewProjMatrix;
uniform float uTime;
uniform vec3 uRotationCenter;  // Center point for rotation (typically 0, heightOffset, 0)
uniform float uRotationSpeed;  // Rotation speed multiplier (default 1.0)

out vec3 vColor;
out float vGlow;
out vec3 vNormal;
out vec3 vWorldPos;

// Rotate a point around Y axis (vertical) by angle in radians
vec3 rotateY(vec3 p, float angle) {
    float c = cos(angle);
    float s = sin(angle);
    return vec3(
        c * p.x + s * p.z,
        p.y,
        -s * p.x + c * p.z
    );
}

void main() {
    // Calculate rotation angle based on time
    float rotationAngle = uTime * uRotationSpeed;

    // Translate to rotation center, rotate around Y, translate back
    vec3 localPos = aPos - uRotationCenter;
    vec3 rotatedPos = rotateY(localPos, rotationAngle);
    vec3 finalPos = rotatedPos + uRotationCenter;

    // Transform through model matrix (contains world position)
    highp vec4 worldPos = uModelMatrix * vec4(finalPos, 1.0);
    gl_Position = uViewProjMatrix * worldPos;

    // Also rotate the normal
    vec3 rotatedNormal = rotateY(aNormal, rotationAngle);

    // Transform normal by model matrix
    vNormal = normalize(mat3(uModelMatrix) * rotatedNormal);
    vWorldPos = worldPos.xyz;
    vColor = aColor.rgb;
    vGlow = aColor.a;
}
