export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** index;
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

export function formatCount(value: number, unit = "项"): string {
  return `${new Intl.NumberFormat("zh-CN").format(value)} ${unit}`;
}

export function compactPath(path: string, max = 42): string {
  if (path.length <= max) return path;
  const edge = Math.max(8, Math.floor((max - 1) / 2));
  return `${path.slice(0, edge)}…${path.slice(-edge)}`;
}
