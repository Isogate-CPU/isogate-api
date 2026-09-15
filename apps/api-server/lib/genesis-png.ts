import { createHash } from "node:crypto";
import { deflateSync, constants as zlibConstants } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const GRID_SIZE = 16;
const OUTPUT_SIZE = 512;

/**
 * Convert one RGB565 pixel to the 8-bit channel representation used by the
 * canonical PNG. Math.round is intentional: it is also the representation
 * used by the browser preview, while the PNG itself is generated only here.
 */
function rgb565ToRgba(pixel: number, output: Buffer, offset: number): void {
  const red = Math.round(((pixel >> 11) & 0x1f) * 255 / 31);
  const green = Math.round(((pixel >> 5) & 0x3f) * 255 / 63);
  const blue = Math.round((pixel & 0x1f) * 255 / 31);
  output[offset] = red;
  output[offset + 1] = green;
  output[offset + 2] = blue;
  output[offset + 3] = 0xff;
}

// PNG uses the IEEE CRC-32 polynomial, represented here without a package so
// PNG bytes (and therefore their digest) cannot vary with dependency versions.
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, payload: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, Buffer.from(payload)]);
  const chunk = Buffer.allocUnsafe(12 + payload.byteLength);
  chunk.writeUInt32BE(payload.byteLength, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body), 8 + payload.byteLength);
  return chunk;
}

/**
 * Encode the canonical 16x16 RGB565 recipe as a deterministic 512x512 PNG.
 *
 * The format is deliberately fixed: RGBA8, no interlace, filter type 0 for
 * every scanline, and zlib's fixed-Huffman strategy. Callers should hash the
 * returned bytes, not a re-encoded or browser-generated image.
 */
export function encodeGenesisPng(pixels: readonly number[]): Buffer {
  if (pixels.length !== GRID_SIZE * GRID_SIZE) {
    throw new Error("A canonical RGB565 image must contain exactly 256 pixels.");
  }
  for (const pixel of pixels) {
    if (!Number.isInteger(pixel) || pixel < 0 || pixel > 0xffff) {
      throw new Error("Canonical RGB565 pixels must be integers from 0 through 65535.");
    }
  }

  const rowBytes = OUTPUT_SIZE * 4;
  // Every 16x16 source pixel expands to a 32x32 block. Include one filter byte
  // per row as required by PNG's scanline representation.
  const raw = Buffer.alloc((rowBytes + 1) * OUTPUT_SIZE);
  for (let sourceY = 0; sourceY < GRID_SIZE; sourceY += 1) {
    for (let repeatY = 0; repeatY < OUTPUT_SIZE / GRID_SIZE; repeatY += 1) {
      const rowStart = (sourceY * (OUTPUT_SIZE / GRID_SIZE) + repeatY) * (rowBytes + 1);
      raw[rowStart] = 0;
      for (let sourceX = 0; sourceX < GRID_SIZE; sourceX += 1) {
        const pixel = pixels[sourceY * GRID_SIZE + sourceX];
        for (let repeatX = 0; repeatX < OUTPUT_SIZE / GRID_SIZE; repeatX += 1) {
          const destinationX = sourceX * (OUTPUT_SIZE / GRID_SIZE) + repeatX;
          rgb565ToRgba(pixel, raw, rowStart + 1 + destinationX * 4);
        }
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(OUTPUT_SIZE, 0);
  ihdr.writeUInt32BE(OUTPUT_SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha (RGBA)
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace

  const compressed = deflateSync(raw, {
    level: 9,
    strategy: zlibConstants.Z_FIXED,
  });
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function genesisPngDigest(png: Uint8Array): string {
  return createHash("sha256").update(png).digest("hex");
}

export function encodeGenesisPngWithDigest(pixels: readonly number[]) {
  const png = encodeGenesisPng(pixels);
  return { png, pngDigest: genesisPngDigest(png) };
}