#version 330 core

in vec3 vColor;
in float vGlow;
in vec3 vNormal;
in vec3 vWorldPos;

uniform float uTime;

out vec4 FragColor;

void main() {
    vec3 norm = normalize(vNormal);

    // Use vertex color passed from geometry
    vec3 baseColor = vColor;

    // Primary light from above-front-right for good depth visibility
    vec3 lightDir = normalize(vec3(0.4, 0.8, 0.3));
    float diff = max(dot(norm, lightDir), 0.0);

    // Secondary fill light from opposite side to reduce harsh shadows
    vec3 fillDir = normalize(vec3(-0.3, 0.5, -0.4));
    float fillDiff = max(dot(norm, fillDir), 0.0) * 0.25;

    // Rim lighting - subtle edge highlighting (reduced for less wash-out)
    vec3 fakeViewDir = normalize(vec3(0.0, 0.3, 1.0));
    float rimDot = 1.0 - max(dot(norm, fakeViewDir), 0.0);
    float rim = pow(rimDot, 4.0) * 0.15;  // Tighter falloff, much lower intensity

    // Specular highlight - reduced for more matte appearance
    vec3 halfDir = normalize(lightDir + fakeViewDir);
    float spec = pow(max(dot(norm, halfDir), 0.0), 48.0) * 0.2;  // Tighter, dimmer

    // Lighting composition - more matte, less washed out
    vec3 ambient = vec3(0.25);  // Slightly higher ambient for base visibility
    vec3 diffuse = diff * vec3(0.65) + fillDiff * vec3(0.2);  // Reduced diffuse
    vec3 specular = spec * vec3(0.5, 0.55, 0.6);  // Subtle, less intense
    vec3 rimColor = rim * vec3(0.3, 0.4, 0.5);    // Subtle rim

    // Apply lighting to base color
    vec3 finalColor = baseColor * (ambient + diffuse) + specular + rimColor;

    // Glow effect for south blade
    if (vGlow > 0.5) {
        // Pulsing glow based on time
        float blink = 0.5 + 0.5 * sin(uTime * 6.0);
        vec3 glowColor = vec3(0.9294, 0.7137, 0.1647);

        finalColor = mix(finalColor, glowColor, blink * vGlow * 0.85);
        finalColor += glowColor * blink * vGlow * 0.3;
    }

    // No color boost - keep colors natural
    FragColor = vec4(finalColor, 1.0);
}
