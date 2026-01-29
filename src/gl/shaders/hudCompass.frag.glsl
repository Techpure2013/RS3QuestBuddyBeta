#version 330 core

in vec2 vUV;
out vec4 FragColor;

uniform float uTime;
// Blade glow packed into two vec4s:
// uBladeGlow1 = [N, NE, E, SE]
// uBladeGlow2 = [S, SW, W, NW]
uniform vec4 uBladeGlow1;
uniform vec4 uBladeGlow2;
uniform vec4 uBaseColor;
uniform vec4 uGlowColor;

const float PI = 3.14159265;

// Get glow value for blade index (0-7)
// Only swap E/W cardinals to compensate for game coordinate system
// Ordinals (NE, SE, SW, NW) don't need swapping
float getBladeGlow(int idx) {
    if (idx == 0) return uBladeGlow1.x;      // N - unchanged
    if (idx == 1) return uBladeGlow1.y;      // NE - direct (no swap)
    if (idx == 2) return uBladeGlow2.z;      // E blade gets W glow (cardinal swap)
    if (idx == 3) return uBladeGlow1.w;      // SE - direct (no swap)
    if (idx == 4) return uBladeGlow2.x;      // S - unchanged
    if (idx == 5) return uBladeGlow2.y;      // SW - direct (no swap)
    if (idx == 6) return uBladeGlow1.z;      // W blade gets E glow (cardinal swap)
    return uBladeGlow2.w;                    // NW - direct (no swap)
}

// SDF for a blade shape (triangle pointing outward from center)
float sdBlade(vec2 p, float angle, float length, float width) {
    // Counter-clockwise rotation for standard compass directions
    float c = cos(angle);
    float s = sin(angle);
    vec2 rotP = vec2(p.x * c - p.y * s, p.x * s + p.y * c);

    if (rotP.y < 0.0) return 1000.0;

    float tipDist = rotP.y - length;
    float widthAtY = width * (1.0 - rotP.y / length);
    float sideDist = abs(rotP.x) - widthAtY;

    return max(tipDist, sideDist);
}

// SDF for rounded box (used for letter strokes)
float sdBox(vec2 p, vec2 b) {
    vec2 d = abs(p) - b;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

// Letter "N" SDF
float letterN(vec2 p, float scale) {
    p /= scale;
    float d = 1000.0;
    // Left vertical stroke (widened from 0.012 to 0.016)
    d = min(d, sdBox(p - vec2(-0.038, 0.0), vec2(0.016, 0.055)));
    // Right vertical stroke
    d = min(d, sdBox(p - vec2(0.038, 0.0), vec2(0.016, 0.055)));
    // Diagonal stroke
    float angle = atan(0.11, 0.076);
    float c = cos(angle);
    float s = sin(angle);
    vec2 rotP = vec2(p.x * c + p.y * s, -p.x * s + p.y * c);
    d = min(d, sdBox(rotP, vec2(0.016, 0.068)));
    return d * scale;
}

// Letter "S" SDF (simplified as two arcs)
float letterS(vec2 p, float scale) {
    p /= scale;
    float d = 1000.0;
    // Top curve (arc going right then left) - widened stroke
    float topArc = abs(length(p - vec2(0.0, 0.028)) - 0.032) - 0.016;
    if (p.x < -0.018 && p.y < 0.028) topArc = 1000.0; // cut bottom-left
    // Bottom curve (arc going left then right)
    float botArc = abs(length(p - vec2(0.0, -0.028)) - 0.032) - 0.016;
    if (p.x > 0.018 && p.y > -0.028) botArc = 1000.0; // cut top-right
    d = min(topArc, botArc);
    return d * scale;
}

// Letter "E" SDF
float letterE(vec2 p, float scale) {
    p /= scale;
    float d = 1000.0;
    // Vertical stroke (widened)
    d = min(d, sdBox(p - vec2(-0.028, 0.0), vec2(0.016, 0.055)));
    // Top horizontal
    d = min(d, sdBox(p - vec2(0.006, 0.042), vec2(0.034, 0.014)));
    // Middle horizontal
    d = min(d, sdBox(p - vec2(0.0, 0.0), vec2(0.028, 0.012)));
    // Bottom horizontal
    d = min(d, sdBox(p - vec2(0.006, -0.042), vec2(0.034, 0.014)));
    return d * scale;
}

// Letter "W" SDF
float letterW(vec2 p, float scale) {
    p /= scale;
    float d = 1000.0;
    // Four diagonal strokes forming W
    float angle1 = 0.25;
    float c1 = cos(angle1);
    float s1 = sin(angle1);
    // Left down-stroke
    vec2 p1 = vec2((p.x + 0.035) * c1 + p.y * s1, -(p.x + 0.035) * s1 + p.y * c1);
    d = min(d, sdBox(p1, vec2(0.01, 0.052)));
    // Left up-stroke
    vec2 p2 = vec2((p.x + 0.012) * c1 - p.y * s1, (p.x + 0.012) * s1 + p.y * c1);
    d = min(d, sdBox(p2, vec2(0.01, 0.052)));
    // Right down-stroke
    vec2 p3 = vec2((p.x - 0.012) * c1 + p.y * s1, -(p.x - 0.012) * s1 + p.y * c1);
    d = min(d, sdBox(p3, vec2(0.01, 0.052)));
    // Right up-stroke
    vec2 p4 = vec2((p.x - 0.035) * c1 - p.y * s1, (p.x - 0.035) * s1 + p.y * c1);
    d = min(d, sdBox(p4, vec2(0.01, 0.052)));
    return d * scale;
}

void main() {
    vec2 uv = vUV * 2.0 - 1.0;
    // Flip Y to correct compass orientation (N at top, S at bottom)
    uv.y = -uv.y;
    float dist = length(uv);

    // Discard outside with soft edge (expanded for letter breathing room)
    if (dist > 1.05) discard;

    // Pulsing animation
    float pulse = 0.75 + 0.25 * sin(uTime * 4.0);

    // === BACKGROUND DISC with gradient (expanded radius) ===
    float discMask = smoothstep(1.02, 0.94, dist);
    vec3 discColorOuter = vec3(0.08, 0.12, 0.22);
    vec3 discColorInner = vec3(0.18, 0.25, 0.38);
    vec3 discColor = mix(discColorOuter, discColorInner, 1.0 - dist * 0.9);

    vec3 color = discColor;
    float alpha = discMask * 0.85;

    // === OUTER RING - metallic border (expanded radius for letter room) ===
    float ringDist = abs(dist - 0.95) - 0.025;
    float ring = smoothstep(0.008, -0.008, ringDist);
    float ringHighlight = dot(normalize(uv + vec2(0.3, 0.3)), vec2(-0.707, -0.707)) * 0.5 + 0.5;
    vec3 ringColorBase = vec3(0.35, 0.45, 0.6);
    vec3 ringColorHighlight = vec3(0.7, 0.8, 0.95);
    vec3 ringColor = mix(ringColorBase, ringColorHighlight, ringHighlight * 0.6);
    color = mix(color, ringColor, ring);
    alpha = max(alpha, ring * 0.95);

    // === INNER RING - accent ===
    float innerRingDist = abs(dist - 0.22) - 0.015;
    float innerRing = smoothstep(0.006, -0.006, innerRingDist);
    vec3 innerRingColor = mix(vec3(0.3, 0.4, 0.55), vec3(0.5, 0.6, 0.75), ringHighlight * 0.5);
    color = mix(color, innerRingColor, innerRing);
    alpha = max(alpha, innerRing * 0.9);

    // === CARDINAL BLADES (N, E, S, W) ===
    // Direction correction is handled in getBladeGlow via index swapping
    for (int i = 0; i < 4; i++) {
        float angle = float(i) * PI * 0.5;
        float bladeDist = sdBlade(uv, angle, 0.68, 0.12);
        float blade = smoothstep(0.015, -0.015, bladeDist);

        float edgeDist = bladeDist + 0.025;
        float edge = smoothstep(0.02, 0.0, edgeDist) * smoothstep(-0.04, 0.0, bladeDist);

        int bladeIdx = i * 2;
        float glow = getBladeGlow(bladeIdx);

        vec2 rotP;
        float c = cos(-angle);
        float s = sin(-angle);
        rotP = vec2(uv.x * c - uv.y * s, uv.x * s + uv.y * c);
        float centerFade = 1.0 - abs(rotP.x) * 4.0;
        centerFade = clamp(centerFade, 0.0, 1.0);

        vec3 bladeBase = vec3(0.28, 0.38, 0.58);
        vec3 bladeHighlight = vec3(0.5, 0.6, 0.8);
        vec3 baseBladeColor = mix(bladeBase, bladeHighlight, centerFade * 0.6 + edge * 0.4);

        vec3 glowBladeColor = uGlowColor.rgb * (0.9 + 0.1 * pulse);
        vec3 bladeColor = mix(baseBladeColor, glowBladeColor, glow);
        bladeColor += vec3(0.15, 0.18, 0.22) * edge * (1.0 - glow * 0.5);

        color = mix(color, bladeColor, blade);
        alpha = max(alpha, blade * 0.98);

        // Glow aura
        if (glow > 0.1) {
            float auraDist = bladeDist + 0.06;
            float aura = smoothstep(0.1, -0.02, auraDist) * (1.0 - blade);
            color += uGlowColor.rgb * aura * glow * pulse * 0.5;
            alpha = max(alpha, aura * glow * 0.6);
        }
    }

    // === ORDINAL BLADES (NE, SE, SW, NW) - Made larger and more visible ===
    for (int i = 0; i < 4; i++) {
        float angle = float(i) * PI * 0.5 + PI * 0.25;
        // Increased size: length 0.48->0.55, width 0.095->0.10
        float bladeDist = sdBlade(uv, angle, 0.55, 0.10);
        float blade = smoothstep(0.012, -0.012, bladeDist);

        float edgeDist = bladeDist + 0.02;
        float edge = smoothstep(0.015, 0.0, edgeDist) * smoothstep(-0.03, 0.0, bladeDist);

        int bladeIdx = i * 2 + 1;
        float glow = getBladeGlow(bladeIdx);

        // Brighter base colors for better visibility
        vec3 bladeBase = vec3(0.25, 0.35, 0.52);
        vec3 bladeHighlight = vec3(0.45, 0.55, 0.72);
        vec3 baseBladeColor = mix(bladeBase, bladeHighlight, edge * 0.6);

        vec3 glowBladeColor = uGlowColor.rgb * (0.9 + 0.1 * pulse);
        vec3 bladeColor = mix(baseBladeColor, glowBladeColor, glow);
        bladeColor += vec3(0.14, 0.17, 0.20) * edge * (1.0 - glow * 0.5);

        color = mix(color, bladeColor, blade);
        alpha = max(alpha, blade * 0.98);

        // Glow aura
        if (glow > 0.1) {
            float auraDist = bladeDist + 0.05;
            float aura = smoothstep(0.08, -0.02, auraDist) * (1.0 - blade);
            color += uGlowColor.rgb * aura * glow * pulse * 0.45;
            alpha = max(alpha, aura * glow * 0.55);
        }
    }

    // === DIRECTION LABELS (N, S, E, W) - Large and visible ===
    // Letters use Y-down coords; only N needs X-mirror (diagonal stroke)
    vec2 letterUV = vec2(uv.x, -uv.y);  // Back to Y-down for letter SDFs
    float letterScale = 1.8;
    vec3 letterColor = vec3(0.92, 0.95, 1.0);  // Bright white
    vec3 letterGlowColor = uGlowColor.rgb;

    // N label (top of compass) - ONLY N needs X-mirror to fix its diagonal
    vec2 nLocal = letterUV - vec2(0.0, -0.80);
    float nDist = letterN(vec2(-nLocal.x, nLocal.y), letterScale);
    float nLetter = smoothstep(0.012, -0.012, nDist);
    float nGlow = getBladeGlow(0);
    vec3 nColor = mix(letterColor, letterGlowColor * pulse, nGlow);
    color = mix(color, nColor, nLetter);
    alpha = max(alpha, nLetter * 0.98);

    // S label (bottom of compass) - no X-mirror needed
    float sDist = letterS(letterUV - vec2(0.0, 0.80), letterScale);
    float sLetter = smoothstep(0.012, -0.012, sDist);
    float sGlow = getBladeGlow(4);
    vec3 sColor = mix(letterColor, letterGlowColor * pulse, sGlow);
    color = mix(color, sColor, sLetter);
    alpha = max(alpha, sLetter * 0.98);

    // E label (right) - no X-mirror needed
    float eDist = letterE(letterUV - vec2(0.80, 0.0), letterScale);
    float eLetter = smoothstep(0.012, -0.012, eDist);
    float eGlow = getBladeGlow(2);
    vec3 eColor = mix(letterColor, letterGlowColor * pulse, eGlow);
    color = mix(color, eColor, eLetter);
    alpha = max(alpha, eLetter * 0.98);

    // W label (left) - Y-flip needed (otherwise displays as M)
    vec2 wLocal = letterUV - vec2(-0.80, 0.0);
    float wDist = letterW(vec2(wLocal.x, -wLocal.y), letterScale);
    float wLetter = smoothstep(0.012, -0.012, wDist);
    float wGlow = getBladeGlow(6);
    vec3 wColor = mix(letterColor, letterGlowColor * pulse, wGlow);
    color = mix(color, wColor, wLetter);
    alpha = max(alpha, wLetter * 0.98);

    // === CENTER HUB - jewel with highlight ===
    float hubDist = dist - 0.10;
    float hub = smoothstep(0.01, -0.01, hubDist);
    float hubHighlight = smoothstep(0.08, 0.02, dist) * 0.7;
    vec3 hubColor = mix(vec3(0.2, 0.28, 0.45), vec3(0.5, 0.6, 0.8), hubHighlight);
    color = mix(color, hubColor, hub);
    alpha = max(alpha, hub * 0.98);

    // === OUTER GLOW for visibility (adjusted for expanded radius) ===
    float outerGlow = smoothstep(1.04, 0.94, dist) * (1.0 - smoothstep(0.94, 0.91, dist));
    color += vec3(0.2, 0.3, 0.5) * outerGlow * 0.3;

    if (alpha < 0.01) discard;
    FragColor = vec4(color, alpha);
}
