/**
 * WaveCanvas - Three.js based wave animation for wander radius
 * Uses CanvasTexture for smooth time-based animation
 * Can be exported and run as a standalone program or integrated with patchrs
 */

import * as THREE from 'three';

export interface WaveCanvasOptions {
    width?: number;
    height?: number;
    waveHeight?: number;
    waveFreq?: number;
    waveSpeed?: number;
    color?: THREE.ColorRepresentation;
    outlineColor?: THREE.ColorRepresentation;
}

export class WaveCanvas {
    private scene: THREE.Scene;
    private camera: THREE.OrthographicCamera;
    private renderer: THREE.WebGLRenderer;
    private canvas: HTMLCanvasElement;
    private mesh: THREE.Mesh | null = null;
    private material: THREE.ShaderMaterial | null = null;
    private animationId: number | null = null;
    private startTime: number;

    // Wave parameters
    private waveHeight: number;
    private waveFreq: number;
    private waveSpeed: number;

    constructor(options: WaveCanvasOptions = {}) {
        const {
            width = 512,
            height = 512,
            waveHeight = 0.1,
            waveFreq = 4.0,
            waveSpeed = 2.0,
            color = 0x00ffff,
            outlineColor = 0x00ffff
        } = options;

        this.waveHeight = waveHeight;
        this.waveFreq = waveFreq;
        this.waveSpeed = waveSpeed;
        this.startTime = performance.now() / 1000;

        // Create canvas
        this.canvas = document.createElement('canvas');
        this.canvas.width = width;
        this.canvas.height = height;

        // Create Three.js scene
        this.scene = new THREE.Scene();

        // Orthographic camera for 2D-style rendering
        const aspect = width / height;
        this.camera = new THREE.OrthographicCamera(-aspect, aspect, 1, -1, 0.1, 100);
        this.camera.position.z = 5;

        // Create renderer
        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            alpha: true,
            antialias: true
        });
        this.renderer.setSize(width, height);
        this.renderer.setClearColor(0x000000, 0);

        // Create wave mesh
        this.createWaveMesh(color, outlineColor);
    }

    private createWaveMesh(color: THREE.ColorRepresentation, outlineColor: THREE.ColorRepresentation): void {
        // Vertex shader with wave animation
        const vertexShader = `
            uniform float uTime;
            uniform float uWaveHeight;
            uniform float uWaveFreq;
            uniform float uWaveSpeed;

            varying vec2 vUv;
            varying float vWave;

            void main() {
                vUv = uv;

                // Calculate wave based on position and time
                float wave = sin((position.x + position.y) * uWaveFreq - uTime * uWaveSpeed);
                wave += sin((position.x * 1.5 - position.y) * uWaveFreq * 0.7 + uTime * uWaveSpeed * 0.5) * 0.5;
                wave = wave * 0.5 + 0.5; // Normalize to 0-1

                vWave = wave;

                vec3 pos = position;
                pos.z += wave * uWaveHeight;

                gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
            }
        `;

        // Fragment shader with color based on wave height
        const fragmentShader = `
            uniform vec3 uColor;
            uniform vec3 uOutlineColor;
            uniform float uTime;

            varying vec2 vUv;
            varying float vWave;

            void main() {
                // Create border effect
                float borderWidth = 0.05;
                float border = step(borderWidth, vUv.x) * step(borderWidth, vUv.y) *
                               step(borderWidth, 1.0 - vUv.x) * step(borderWidth, 1.0 - vUv.y);

                // Mix colors based on wave height and border
                vec3 fillColor = mix(uColor * 0.3, uColor, vWave);
                vec3 finalColor = mix(uOutlineColor, fillColor, border);

                // Add some glow on wave peaks
                float glow = pow(vWave, 2.0) * 0.5;
                finalColor += vec3(glow);

                // Alpha based on wave for pulsing effect
                float alpha = 0.6 + vWave * 0.4;

                gl_FragColor = vec4(finalColor, alpha * (1.0 - border * 0.3));
            }
        `;

        // Create shader material
        this.material = new THREE.ShaderMaterial({
            uniforms: {
                uTime: { value: 0 },
                uWaveHeight: { value: this.waveHeight },
                uWaveFreq: { value: this.waveFreq },
                uWaveSpeed: { value: this.waveSpeed },
                uColor: { value: new THREE.Color(color) },
                uOutlineColor: { value: new THREE.Color(outlineColor) }
            },
            vertexShader,
            fragmentShader,
            transparent: true,
            side: THREE.DoubleSide
        });

        // Create plane geometry
        const geometry = new THREE.PlaneGeometry(2, 2, 32, 32);
        this.mesh = new THREE.Mesh(geometry, this.material);
        this.scene.add(this.mesh);
    }

    /**
     * Start the animation loop
     */
    start(): void {
        if (this.animationId !== null) return;

        const animate = () => {
            this.animationId = requestAnimationFrame(animate);
            this.update();
            this.render();
        };

        animate();
    }

    /**
     * Stop the animation loop
     */
    stop(): void {
        if (this.animationId !== null) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }

    /**
     * Update uniforms
     */
    update(): void {
        if (this.material) {
            const currentTime = performance.now() / 1000 - this.startTime;
            this.material.uniforms.uTime.value = currentTime;
        }
    }

    /**
     * Render the scene
     */
    render(): void {
        this.renderer.render(this.scene, this.camera);
    }

    /**
     * Get the canvas element
     */
    getCanvas(): HTMLCanvasElement {
        return this.canvas;
    }

    /**
     * Get canvas as ImageData for use with patchrs textures
     */
    getImageData(): ImageData {
        const ctx = this.canvas.getContext('2d');
        if (!ctx) throw new Error('Could not get 2D context');
        return ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    }

    /**
     * Get canvas as data URL
     */
    toDataURL(): string {
        return this.canvas.toDataURL();
    }

    /**
     * Set wave parameters
     */
    setWaveParams(height?: number, freq?: number, speed?: number): void {
        if (this.material) {
            if (height !== undefined) this.material.uniforms.uWaveHeight.value = height;
            if (freq !== undefined) this.material.uniforms.uWaveFreq.value = freq;
            if (speed !== undefined) this.material.uniforms.uWaveSpeed.value = speed;
        }
    }

    /**
     * Set colors
     */
    setColors(color?: THREE.ColorRepresentation, outlineColor?: THREE.ColorRepresentation): void {
        if (this.material) {
            if (color !== undefined) this.material.uniforms.uColor.value = new THREE.Color(color);
            if (outlineColor !== undefined) this.material.uniforms.uOutlineColor.value = new THREE.Color(outlineColor);
        }
    }

    /**
     * Resize the canvas
     */
    resize(width: number, height: number): void {
        this.canvas.width = width;
        this.canvas.height = height;
        this.renderer.setSize(width, height);

        const aspect = width / height;
        this.camera.left = -aspect;
        this.camera.right = aspect;
        this.camera.updateProjectionMatrix();
    }

    /**
     * Dispose of Three.js resources
     */
    dispose(): void {
        this.stop();

        if (this.mesh) {
            this.mesh.geometry.dispose();
            this.scene.remove(this.mesh);
        }

        if (this.material) {
            this.material.dispose();
        }

        this.renderer.dispose();
    }
}

/**
 * Create a standalone wave animation window (for testing)
 */
export function createWaveWindow(options: WaveCanvasOptions = {}): WaveCanvas {
    const wave = new WaveCanvas({
        width: 400,
        height: 400,
        waveHeight: 0.15,
        waveFreq: 5.0,
        waveSpeed: 2.5,
        color: 0x00ffff,
        outlineColor: 0x00ffff,
        ...options
    });

    // Create a container div
    const container = document.createElement('div');
    container.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        border: 2px solid #00ffff;
        border-radius: 8px;
        overflow: hidden;
        box-shadow: 0 0 20px rgba(0, 255, 255, 0.5);
        z-index: 10000;
    `;

    container.appendChild(wave.getCanvas());
    document.body.appendChild(container);

    wave.start();

    return wave;
}

export default WaveCanvas;
