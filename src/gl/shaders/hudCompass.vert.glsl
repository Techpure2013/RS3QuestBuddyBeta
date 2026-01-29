#version 330 core

layout (location = 0) in vec2 aPos;
layout (location = 1) in vec2 aUV;

uniform vec2 uScreenSize;
uniform vec2 uPosition;
uniform vec2 uSize;
uniform float uFlipY;

out vec2 vUV;

void main() {
    // Scale vertex position (0-1) to actual size
    vec2 scaledPos = aPos * uSize;
    // Add position offset
    vec2 screenPos = scaledPos + uPosition;
    // Convert to NDC: [0, screenSize] -> [-1, 1]
    vec2 ndc = (screenPos / uScreenSize) * 2.0 - 1.0;
    // Conditionally flip Y axis based on render target
    if (uFlipY > 0.5) {
        ndc.y = -ndc.y;
    }
    gl_Position = vec4(ndc, 0.0, 1.0);
    vUV = aUV;
}
