/**
 * WaveHtmlOverlay - Renders animated wave as HTML overlay positioned over game
 * Uses Three.js for smooth animation, positioned using screen coordinates
 */

import * as THREE from 'three';

export interface WaveHtmlOverlayOptions {
    color?: number;
    waveHeight?: number;
    waveFreq?: number;
    waveSpeed?: number;
}

export class WaveHtmlOverlay {
    private container: HTMLDivElement;
    private canvas: HTMLCanvasElement;
    private scene: THREE.Scene;
    private camera: THREE.OrthographicCamera;
    private renderer: THREE.WebGLRenderer;
    private material: THREE.ShaderMaterial;
    private mesh: THREE.Mesh;
    private startTime: number;
    private animationId: number | null = null;
    private isVisible = false;

    constructor(options: WaveHtmlOverlayOptions = {}) {
        const {
            color = 0x00ffff,
            waveHeight = 0.12,
            waveFreq = 6.0,
            waveSpeed = 2.0
        } = options;

        this.startTime = performance.now() / 1000;

        // Create container div
        this.container = document.createElement('div');
        this.container.style.cssText = `
            position: fixed;
            pointer-events: none;
            z-index: 9999;
            display: none;
        `;
        document.body.appendChild(this.container);

        // Create canvas
        this.canvas = document.createElement('canvas');
        this.container.appendChild(this.canvas);

        // Three.js setup
        this.scene = new THREE.Scene();
        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
        this.camera.position.z = 5;

        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            alpha: true,
            antialias: true
        });
        this.renderer.setClearColor(0x000000, 0);

        // Wave shader
        const vertexShader = `
            uniform float uTime;
            uniform float uWaveHeight;
            uniform float uWaveFreq;
            uniform float uWaveSpeed;

            varying vec2 vUv;
            varying float vWave;

            void main() {
                vUv = uv;

                float wave = sin((position.x + position.y) * uWaveFreq - uTime * uWaveSpeed);
                wave += sin((position.x * 1.3 - position.y * 0.7) * uWaveFreq * 0.8 + uTime * uWaveSpeed * 0.6) * 0.5;
                wave += sin(position.y * uWaveFreq * 1.2 - uTime * uWaveSpeed * 0.8) * 0.3;
                wave = wave * 0.25 + 0.5;

                vWave = wave;

                vec3 pos = position;
                pos.z += wave * uWaveHeight;

                gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
            }
        `;

        const fragmentShader = `
            uniform vec3 uColor;
            uniform float uTime;

            varying vec2 vUv;
            varying float vWave;

            void main() {
                // Border detection
                float borderWidth = 0.06;
                float distFromEdge = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
                float border = smoothstep(0.0, borderWidth, distFromEdge);
                float innerGlow = smoothstep(borderWidth, borderWidth * 3.0, distFromEdge);

                // Wave-based coloring
                vec3 peakColor = uColor * 1.6 + vec3(0.2);
                vec3 troughColor = uColor * 0.2;
                vec3 waveColor = mix(troughColor, peakColor, vWave);

                // Bright outline
                vec3 outlineColor = uColor + vec3(0.4);

                // Combine
                vec3 finalColor = mix(outlineColor, waveColor, innerGlow);

                // Add shimmer on peaks
                float shimmer = pow(vWave, 4.0) * 0.4;
                finalColor += vec3(shimmer);

                // Alpha - outline more solid
                float alpha = mix(0.95, 0.35 + vWave * 0.35, innerGlow);

                gl_FragColor = vec4(finalColor, alpha);
            }
        `;

        this.material = new THREE.ShaderMaterial({
            uniforms: {
                uTime: { value: 0 },
                uWaveHeight: { value: waveHeight },
                uWaveFreq: { value: waveFreq },
                uWaveSpeed: { value: waveSpeed },
                uColor: { value: new THREE.Color(color) }
            },
            vertexShader,
            fragmentShader,
            transparent: true,
            side: THREE.DoubleSide
        });

        const geometry = new THREE.PlaneGeometry(2, 2, 48, 48);
        this.mesh = new THREE.Mesh(geometry, this.material);
        this.scene.add(this.mesh);
    }

    /**
     * Show the overlay at a specific screen position and size
     */
    show(x: number, y: number, width: number, height: number): void {
        this.container.style.left = `${x}px`;
        this.container.style.top = `${y}px`;
        this.container.style.display = 'block';

        this.canvas.width = width;
        this.canvas.height = height;
        this.renderer.setSize(width, height);

        const aspect = width / height;
        this.camera.left = -aspect;
        this.camera.right = aspect;
        this.camera.updateProjectionMatrix();

        if (!this.isVisible) {
            this.isVisible = true;
            this.startAnimation();
        }
    }

    /**
     * Hide the overlay
     */
    hide(): void {
        this.container.style.display = 'none';
        this.isVisible = false;
        this.stopAnimation();
    }

    /**
     * Update position (call each frame to track world position)
     */
    updatePosition(x: number, y: number, width?: number, height?: number): void {
        this.container.style.left = `${x}px`;
        this.container.style.top = `${y}px`;

        if (width !== undefined && height !== undefined) {
            this.canvas.width = width;
            this.canvas.height = height;
            this.renderer.setSize(width, height);

            const aspect = width / height;
            this.camera.left = -aspect;
            this.camera.right = aspect;
            this.camera.updateProjectionMatrix();
        }
    }

    /**
     * Start animation loop
     */
    private startAnimation(): void {
        if (this.animationId !== null) return;

        const animate = () => {
            if (!this.isVisible) return;
            this.animationId = requestAnimationFrame(animate);

            const currentTime = performance.now() / 1000 - this.startTime;
            this.material.uniforms.uTime.value = currentTime;

            this.renderer.render(this.scene, this.camera);
        };

        animate();
    }

    /**
     * Stop animation loop
     */
    private stopAnimation(): void {
        if (this.animationId !== null) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }

    /**
     * Set wave color
     */
    setColor(color: number): void {
        this.material.uniforms.uColor.value = new THREE.Color(color);
    }

    /**
     * Set wave parameters
     */
    setWaveParams(height?: number, freq?: number, speed?: number): void {
        if (height !== undefined) this.material.uniforms.uWaveHeight.value = height;
        if (freq !== undefined) this.material.uniforms.uWaveFreq.value = freq;
        if (speed !== undefined) this.material.uniforms.uWaveSpeed.value = speed;
    }

    /**
     * Dispose and remove from DOM
     */
    dispose(): void {
        this.hide();
        this.mesh.geometry.dispose();
        this.material.dispose();
        this.renderer.dispose();
        this.container.remove();
    }
}

// Singleton instance for easy access
let globalWaveOverlay: WaveHtmlOverlay | null = null;

/**
 * Get or create the global wave overlay instance
 */
export function getWaveOverlay(): WaveHtmlOverlay {
    if (!globalWaveOverlay) {
        globalWaveOverlay = new WaveHtmlOverlay();
    }
    return globalWaveOverlay;
}

/**
 * Show wave overlay at screen position
 */
export function showWaveOverlay(x: number, y: number, width: number, height: number): void {
    getWaveOverlay().show(x, y, width, height);
}

/**
 * Hide wave overlay
 */
export function hideWaveOverlay(): void {
    if (globalWaveOverlay) {
        globalWaveOverlay.hide();
    }
}

/**
 * Test function - show overlay in corner
 */
export function testWaveOverlay(): WaveHtmlOverlay {
    const overlay = getWaveOverlay();
    overlay.show(window.innerWidth - 320, 20, 300, 300);
    return overlay;
}

export default WaveHtmlOverlay;
