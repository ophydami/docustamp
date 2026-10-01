/** "Jane Cooper" -> "JC", "wade.warren@example.com" -> "WW", nothing -> "?". */
export function initials(name: string | undefined | null, email?: string) {
  const src = (name && name.trim()) || email || "?";
  const parts = src.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  const a = parts[0]?.[0] ?? "?";
  const b = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (a + b).toUpperCase();
}
