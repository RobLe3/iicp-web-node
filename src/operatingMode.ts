// SPDX-License-Identifier: Apache-2.0

export type BrowserOperatingMode =
  | "public"
  | "private"
  | "federated_private"
  | "local_only"
  | "custom";

export const RESTRICTED_BROWSER_UNSUPPORTED = "restricted_profile_unsupported";

/** Refuse unsupported modes before discovery, registration or relay work. */
export function requireSupportedBrowserMode(mode: BrowserOperatingMode = "public"): void {
  if (mode !== "public") {
    throw new Error(RESTRICTED_BROWSER_UNSUPPORTED);
  }
}
