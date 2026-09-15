import { createHash } from "node:crypto";

const OPERATIONS = ["LOAD", "ADD", "XOR", "ROTATE"] as const;
const CHECKPOINT_CYCLES = [4, 9, 14, 19, 24] as const;

export interface ReplayInput {
  inputs: number[];
  cycles?: number;
}

export interface CpuArtInput {
  seed: number[];
}

export interface CpuArtResult {
  engine: "isogate-cpu-art-rgb565-v1";
  cpuEngine: "isogate-deterministic-replay-v1";
  colorModel: "RGB565";
  width: 16;
  height: 16;
  bitsPerPixel: 16;
  cyclesPerPixel: 32;
  seed: number[];
  tokenName: string;
  symbol: string;
  description: string;
  pixels: number[];
  cpuDigest: string;
  imageDigest: string;
}

export function runCpuReplay({ inputs, cycles = 32 }: ReplayInput) {
  let accumulator = inputs[0] ?? 0;
  const trace = [];

  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    const lane = (cycle - 1) % inputs.length;
    const input = inputs[lane]!;
    const operation = OPERATIONS[(cycle - 1) % OPERATIONS.length]!;
    const previous = accumulator;

    if (operation === "LOAD") accumulator = input;
    if (operation === "ADD") accumulator = (accumulator + input + cycle) & 0xff;
    if (operation === "XOR") accumulator ^= input;
    if (operation === "ROTATE") accumulator = ((accumulator << 1) | (accumulator >> 7)) & 0xff;

    const ram = (input ^ ((cycle * 9 + 0x0e) & 0xff)) & 0xff;
    trace.push({
      cycle,
      pc: 0x20 + cycle * 4,
      accumulator,
      ram,
      zero: accumulator === 0,
      carry: operation === "ADD" && previous + input + cycle > 0xff,
      // HLT is the program's cycle-32 instruction, not the end of a
      // truncated request. This keeps partial replays canonical.
      halted: cycle === 32,
      lane,
      input,
      operation,
    });
  }

  const finalState = trace.at(-1)!;
  const outputs = inputs.map((input, lane) =>
    (input ^ accumulator ^ ((lane + 1) * 17)) & 0xff,
  );
  const checkpoints = CHECKPOINT_CYCLES.filter((cycle) => cycle <= cycles);
  const canonical = JSON.stringify({ inputs, cycles, finalState, outputs, checkpoints, trace });
  const digest = createHash("sha256").update(canonical).digest("hex");

  return {
    engine: "isogate-deterministic-replay-v1",
    digestAlgorithm: "SHA-256" as const,
    digest,
    inputs,
    requestedCycles: cycles,
    finalState,
    outputs,
    checkpoints,
    trace,
  };
}

const IDENTITY_SYLLABLES = [
  "ar", "be", "cy", "do", "el", "fi", "ga", "hy",
  "io", "ju", "ka", "ly", "mu", "ne", "ox", "py",
  "qu", "ra", "sy", "tu", "ul", "ve", "wy", "xe",
  "yo", "za", "br", "cr", "dr", "fr", "gr", "kr",
] as const;
const IDENTITY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DESCRIPTION_FORMS = ["signal", "artifact", "construct", "pattern", "origin", "network", "cipher", "pulse"] as const;
const DESCRIPTION_TRAITS = ["deterministic", "finite", "recursive", "bounded", "symmetric", "canonical", "luminous", "encoded"] as const;
const DESCRIPTION_MOTIONS = ["computed", "assembled", "resolved", "rendered", "derived", "formed", "mapped", "verified"] as const;

export function runCpuArt({ seed }: CpuArtInput): CpuArtResult {
  if (seed.length !== 8 || seed.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new RangeError("CPU art seed must contain exactly eight bytes.");
  }

  const pixels: number[] = [];
  const replayDigestBytes: Buffer[] = [];
  const identityBytes: number[] = [];

  for (let pixel = 0; pixel < 256; pixel += 1) {
    const x = pixel % 16;
    const y = Math.floor(pixel / 16);
    const inputs = seed.map((byte, lane) =>
      (byte + x * 17 + y * 31 + lane * 13 + pixel) & 0xff,
    );
    const replay = runCpuReplay({ inputs, cycles: 32 });
    replayDigestBytes.push(Buffer.from(replay.digest, "hex"));
    identityBytes.push(...replay.outputs);

    const red = replay.outputs[0]! & 0xf8;
    const green = replay.outputs[1]! & 0xfc;
    const blue = replay.outputs[2]! & 0xf8;
    pixels.push(((red << 8) | (green << 3) | (blue >> 3)) & 0xffff);
  }

  const pixelBytes = Buffer.allocUnsafe(pixels.length * 2);
  pixels.forEach((pixel, index) => pixelBytes.writeUInt16BE(pixel, index * 2));
  const imageDigest = createHash("sha256").update(pixelBytes).digest("hex");
  const cpuDigest = createHash("sha256").update(Buffer.concat(replayDigestBytes)).digest("hex");

  const tokenName = [
    IDENTITY_SYLLABLES[identityBytes[3]! % IDENTITY_SYLLABLES.length],
    IDENTITY_SYLLABLES[identityBytes[67]! % IDENTITY_SYLLABLES.length],
    IDENTITY_SYLLABLES[identityBytes[131]! % IDENTITY_SYLLABLES.length],
  ].join("").replace(/^./, (letter) => letter.toUpperCase());
  const symbol = Array.from({ length: 6 }, (_, index) =>
    IDENTITY_ALPHABET[identityBytes[195 + index * 37]! % IDENTITY_ALPHABET.length],
  ).join("");
  const description = `A ${
    DESCRIPTION_TRAITS[identityBytes[421]! % DESCRIPTION_TRAITS.length]
  } ${
    DESCRIPTION_FORMS[identityBytes[613]! % DESCRIPTION_FORMS.length]
  } ${
    DESCRIPTION_MOTIONS[identityBytes[997]! % DESCRIPTION_MOTIONS.length]
  } by the Isogate deterministic CPU.`;

  return {
    engine: "isogate-cpu-art-rgb565-v1",
    cpuEngine: "isogate-deterministic-replay-v1",
    colorModel: "RGB565" as const,
    width: 16,
    height: 16,
    bitsPerPixel: 16,
    cyclesPerPixel: 32,
    seed: [...seed],
    tokenName,
    symbol,
    description,
    pixels,
    cpuDigest,
    imageDigest,
  };
}