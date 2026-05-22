// Shared PATH normalization for daemon and child-process environments.
// Keep common Linux tool locations available even when systemd/snap launches
// Jeriko with a stripped PATH. This prevents agents from falsely reporting
// tools like gcloud as missing when they are installed under /snap/bin.

export const COMMON_TOOL_PATHS = [
  "/snap/bin",
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
];

export function normalizeToolPath(pathValue: string | undefined, prepend: string[] = []): string {
  const seen = new Set<string>();
  const parts = [...prepend, ...(pathValue ?? "").split(":"), ...COMMON_TOOL_PATHS]
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      if (seen.has(part)) return false;
      seen.add(part);
      return true;
    });
  return parts.join(":");
}
