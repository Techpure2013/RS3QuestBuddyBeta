/**
 * Perceptual Hash (pHash/dHash) Implementation
 *
 * Unlike CRC32 which changes completely with a single pixel difference,
 * perceptual hashes produce similar values for visually similar images.
 *
 * This allows matching item icons across client reloads where the
 * icons are re-rendered with minor pixel differences.
 */

/**
 * Compute a difference hash (dHash) for an image
 *
 * Algorithm:
 * 1. Resize to 9x8 grayscale (gives 72 pixels)
 * 2. Compare each pixel to its right neighbor
 * 3. If left > right, bit = 1, else bit = 0
 * 4. Produces 64-bit hash (8 rows × 8 comparisons)
 *
 * @param imageData - Raw RGBA pixel data
 * @param width - Image width
 * @param height - Image height
 * @returns 64-bit hash as bigint
 */
export function dHash(imageData: Uint8Array | Uint8ClampedArray, width: number, height: number): bigint {
  // Target size for hash computation
  const HASH_WIDTH = 9;
  const HASH_HEIGHT = 8;

  // Step 1: Resize to 9x8 grayscale
  const grayscale = resizeToGrayscale(imageData, width, height, HASH_WIDTH, HASH_HEIGHT);

  // Step 2: Compute difference hash
  let hash = 0n;
  let bit = 0n;

  for (let y = 0; y < HASH_HEIGHT; y++) {
    for (let x = 0; x < HASH_WIDTH - 1; x++) {
      const left = grayscale[y * HASH_WIDTH + x];
      const right = grayscale[y * HASH_WIDTH + x + 1];

      if (left > right) {
        hash |= (1n << bit);
      }
      bit++;
    }
  }

  return hash;
}

/**
 * Compute an average hash (aHash) for an image
 *
 * Algorithm:
 * 1. Resize to 8x8 grayscale
 * 2. Compute average pixel value
 * 3. Each pixel above average = 1, below = 0
 * 4. Produces 64-bit hash
 *
 * @param imageData - Raw RGBA pixel data
 * @param width - Image width
 * @param height - Image height
 * @returns 64-bit hash as bigint
 */
export function aHash(imageData: Uint8Array | Uint8ClampedArray, width: number, height: number): bigint {
  const HASH_SIZE = 8;

  // Step 1: Resize to 8x8 grayscale
  const grayscale = resizeToGrayscale(imageData, width, height, HASH_SIZE, HASH_SIZE);

  // Step 2: Compute average
  let sum = 0;
  for (let i = 0; i < grayscale.length; i++) {
    sum += grayscale[i];
  }
  const avg = sum / grayscale.length;

  // Step 3: Compute hash
  let hash = 0n;
  for (let i = 0; i < grayscale.length; i++) {
    if (grayscale[i] > avg) {
      hash |= (1n << BigInt(i));
    }
  }

  return hash;
}

/**
 * Resize image to grayscale at target dimensions using bilinear interpolation
 */
function resizeToGrayscale(
  imageData: Uint8Array | Uint8ClampedArray,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number
): number[] {
  const result: number[] = new Array(dstWidth * dstHeight);

  const xRatio = srcWidth / dstWidth;
  const yRatio = srcHeight / dstHeight;

  for (let y = 0; y < dstHeight; y++) {
    for (let x = 0; x < dstWidth; x++) {
      // Map to source coordinates
      const srcX = x * xRatio;
      const srcY = y * yRatio;

      // Bilinear interpolation
      const x0 = Math.floor(srcX);
      const y0 = Math.floor(srcY);
      const x1 = Math.min(x0 + 1, srcWidth - 1);
      const y1 = Math.min(y0 + 1, srcHeight - 1);

      const xFrac = srcX - x0;
      const yFrac = srcY - y0;

      // Get grayscale values at 4 corners
      const g00 = getGrayscale(imageData, srcWidth, x0, y0);
      const g10 = getGrayscale(imageData, srcWidth, x1, y0);
      const g01 = getGrayscale(imageData, srcWidth, x0, y1);
      const g11 = getGrayscale(imageData, srcWidth, x1, y1);

      // Interpolate
      const top = g00 * (1 - xFrac) + g10 * xFrac;
      const bottom = g01 * (1 - xFrac) + g11 * xFrac;
      const value = top * (1 - yFrac) + bottom * yFrac;

      result[y * dstWidth + x] = value;
    }
  }

  return result;
}

/**
 * Get grayscale value at pixel (x, y) from RGBA data
 * Uses luminance formula: 0.299*R + 0.587*G + 0.114*B
 */
function getGrayscale(imageData: Uint8Array | Uint8ClampedArray, width: number, x: number, y: number): number {
  const idx = (y * width + x) * 4;
  const r = imageData[idx];
  const g = imageData[idx + 1];
  const b = imageData[idx + 2];
  const a = imageData[idx + 3];

  // If transparent, treat as white background
  if (a < 128) {
    return 255;
  }

  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Get alpha-based value for font character hashing
 * Uses alpha channel to differentiate visible vs transparent pixels
 * This works better for font characters (white text on transparent bg)
 */
function getAlphaValue(imageData: Uint8Array | Uint8ClampedArray, width: number, x: number, y: number): number {
  const idx = (y * width + x) * 4;
  const a = imageData[idx + 3];
  // Invert: transparent (0) -> 255, opaque (255) -> 0
  // This makes visible pixels "dark" and transparent "light"
  return 255 - a;
}

/**
 * Resize image to alpha-based values at target dimensions
 * Used for font character hashing where shape matters more than color
 */
function resizeToAlpha(
  imageData: Uint8Array | Uint8ClampedArray,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number
): number[] {
  const result: number[] = new Array(dstWidth * dstHeight);

  const xRatio = srcWidth / dstWidth;
  const yRatio = srcHeight / dstHeight;

  for (let y = 0; y < dstHeight; y++) {
    for (let x = 0; x < dstWidth; x++) {
      // Map to source coordinates
      const srcX = x * xRatio;
      const srcY = y * yRatio;

      // Bilinear interpolation
      const x0 = Math.floor(srcX);
      const y0 = Math.floor(srcY);
      const x1 = Math.min(x0 + 1, srcWidth - 1);
      const y1 = Math.min(y0 + 1, srcHeight - 1);

      const xFrac = srcX - x0;
      const yFrac = srcY - y0;

      // Get alpha values at 4 corners
      const a00 = getAlphaValue(imageData, srcWidth, x0, y0);
      const a10 = getAlphaValue(imageData, srcWidth, x1, y0);
      const a01 = getAlphaValue(imageData, srcWidth, x0, y1);
      const a11 = getAlphaValue(imageData, srcWidth, x1, y1);

      // Interpolate
      const top = a00 * (1 - xFrac) + a10 * xFrac;
      const bottom = a01 * (1 - xFrac) + a11 * xFrac;
      const value = top * (1 - yFrac) + bottom * yFrac;

      result[y * dstWidth + x] = value;
    }
  }

  return result;
}

/**
 * Compute a difference hash for font characters
 * Uses alpha channel instead of luminance to differentiate character shapes
 *
 * @param imageData - Raw RGBA pixel data
 * @param width - Image width
 * @param height - Image height
 * @returns 64-bit hash as bigint
 */
export function fontHash(imageData: Uint8Array | Uint8ClampedArray, width: number, height: number): bigint {
  const HASH_WIDTH = 9;
  const HASH_HEIGHT = 8;

  // Resize using alpha values
  const alphaMap = resizeToAlpha(imageData, width, height, HASH_WIDTH, HASH_HEIGHT);

  // Compute difference hash
  let hash = 0n;
  let bit = 0n;

  for (let y = 0; y < HASH_HEIGHT; y++) {
    for (let x = 0; x < HASH_WIDTH - 1; x++) {
      const left = alphaMap[y * HASH_WIDTH + x];
      const right = alphaMap[y * HASH_WIDTH + x + 1];

      if (left > right) {
        hash |= (1n << bit);
      }
      bit++;
    }
  }

  return hash;
}

/**
 * Compute Hamming distance between two hashes
 *
 * Hamming distance = number of bits that differ
 * - 0 = identical
 * - 1-5 = very similar (likely same image with minor differences)
 * - 6-10 = somewhat similar
 * - 11+ = different images
 *
 * @param hash1 - First 64-bit hash
 * @param hash2 - Second 64-bit hash
 * @returns Number of differing bits (0-64)
 */
export function hammingDistance(hash1: bigint, hash2: bigint): number {
  let xor = hash1 ^ hash2;
  let distance = 0;

  while (xor > 0n) {
    distance += Number(xor & 1n);
    xor >>= 1n;
  }

  return distance;
}

/**
 * Check if two hashes are similar within a threshold
 *
 * @param hash1 - First hash
 * @param hash2 - Second hash
 * @param threshold - Maximum Hamming distance to consider similar (default: 10)
 * @returns true if hashes are similar
 */
export function isSimilar(hash1: bigint, hash2: bigint, threshold: number = 10): boolean {
  return hammingDistance(hash1, hash2) <= threshold;
}

/**
 * Convert hash to hex string for storage/display
 */
export function hashToHex(hash: bigint): string {
  return hash.toString(16).padStart(16, '0');
}

/**
 * Convert hex string back to hash
 */
export function hexToHash(hex: string): bigint {
  return BigInt('0x' + hex);
}

/**
 * Compute perceptual hash from ImageData object
 */
export function pHashFromImageData(img: ImageData): bigint {
  return dHash(img.data, img.width, img.height);
}

/**
 * Compute both CRC32 and pHash for comparison/migration
 */
export function dualHash(imageData: Uint8Array | Uint8ClampedArray, width: number, height: number): {
  crc32: number;
  pHash: bigint;
  pHashHex: string;
} {
  // Import crc32 dynamically to avoid circular deps
  const { crc32 } = require('./crc32');

  // CRC32 with the blue fix
  const data = new Uint8Array(imageData);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 2] === 0) data[i + 2] = 1;
  }

  const crcHash = crc32(data);
  const perceptualHash = dHash(imageData, width, height);

  return {
    crc32: crcHash,
    pHash: perceptualHash,
    pHashHex: hashToHex(perceptualHash),
  };
}

/**
 * Find best match from a list of known hashes
 *
 * @param targetHash - Hash to match
 * @param knownHashes - Map of name -> hash
 * @param threshold - Maximum distance to consider a match
 * @returns Best match or null
 */
export function findBestMatch(
  targetHash: bigint,
  knownHashes: Map<string, bigint>,
  threshold: number = 10
): { name: string; distance: number } | null {
  let bestMatch: { name: string; distance: number } | null = null;

  for (const [name, hash] of knownHashes) {
    const distance = hammingDistance(targetHash, hash);

    if (distance <= threshold) {
      if (!bestMatch || distance < bestMatch.distance) {
        bestMatch = { name, distance };
      }
    }
  }

  return bestMatch;
}
