/**
 * Cross-package replay fixtures. Consumers should assert both the digest and
 * halted state for each requested cycle; a change to either is a protocol
 * change and must update the server and native node together.
 */
export const REPLAY_TEST_INPUTS = [0x2a, 0x11, 0x00, 0x01, 0xa8, 0x3c, 0x10, 0xff] as const;

export const REPLAY_TEST_VECTORS = [
  {
    cycles: 1,
    digest: "61eabdf0cd3e808052488108b3b7fc35022f04ff12f67ccfae9f5d9c322e6df6",
    halted: false,
  },
  {
    cycles: 8,
    digest: "42dcc2e21cb2706583b28a80acdbab3294ad0c67fed2edb87ca6a3f8398643b5",
    halted: false,
  },
  {
    cycles: 31,
    digest: "38d76897de5d253481cd36f095abedce708706ac39bbce63d72a96a77a44cac4",
    halted: false,
  },
  {
    cycles: 32,
    digest: "c2ed272328262fa1ec0e717dbd2b66831c15e269df83a08c7dc369dfe27063fa",
    halted: true,
  },
] as const;