/**
 * Where this deployment's source code can be downloaded. The AGPL asks anyone
 * who runs a modified copy for other people to offer those people its source,
 * so an operator who changes the code sets VITE_SOURCE_URL to their own
 * repository at build time.
 */
export const SOURCE_URL: string =
  import.meta.env.VITE_SOURCE_URL || "https://github.com/ophydami/docustamp";
