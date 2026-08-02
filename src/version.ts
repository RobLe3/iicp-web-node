// Browser implementation and IICP SDK-compatibility versions are separate axes.
// Keep package.json synchronized with BROWSER_NODE_VERSION; the quality gate
// rejects drift. SDK compatibility describes the registration contract only.
export const BROWSER_NODE_VERSION = "0.2.3";
export const BROWSER_NODE_SDK_COMPATIBILITY_VERSION = "0.7.101";

/** Backward-compatible registration value for directories that know only sdk_version. */
export const BROWSER_NODE_SDK_VERSION = BROWSER_NODE_SDK_COMPATIBILITY_VERSION;
