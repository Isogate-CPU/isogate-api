import { runCpuArt, runCpuReplay } from "@isogate/replay";

export type ProviderWorkload = "cpu_replay" | "cpu_art_rgb565";

export function canonicalProviderJobResult({
  workload,
  inputs,
  cycles,
}: {
  workload: ProviderWorkload;
  inputs: number[];
  cycles: number;
}) {
  return workload === "cpu_art_rgb565"
    ? runCpuArt({ seed: inputs })
    : runCpuReplay({ inputs, cycles });
}

export function canonicalProviderJobDigest(
  result: ReturnType<typeof canonicalProviderJobResult>,
) {
  return "digest" in result ? result.digest : result.imageDigest;
}

export function canonicalProviderJobDigestAlgorithm() {
  return "SHA-256" as const;
}