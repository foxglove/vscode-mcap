/** IEC units, with exact bytes available in the UI tooltip. */
export function formatBytes(value: string | number): string {
  const bytes = Number(value);
  if (bytes === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${Number((bytes / 1024 ** index).toFixed(index === 0 ? 0 : 2))} ${units[index]}`;
}
export function formatDuration(value: string | undefined): string {
  if (value === undefined) return "—";
  // Work on the string so nanosecond precision isn't lost to floating point.
  return `${value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value} s`;
}
