const MAX_REPORT_LENGTH = 128 * 1024;

interface QuotaWindow {
  readonly id: string;
  readonly label: string;
  readonly remaining: number | null;
  readonly resetsAt: string | null;
}

export interface AntigravityQuotaGroup {
  readonly name: string;
  readonly windows: readonly QuotaWindow[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeReport(text: string): readonly AntigravityQuotaGroup[] | null {
  let report: unknown;
  try {
    report = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(report) || report.status !== "SUCCESS" || report.num_turns !== 0) return null;
  const command = report.command;
  if (!isObject(command) || command.name !== "usage" || !isObject(command.data)) return null;
  const groups: unknown = command.data.groups;
  if (!Array.isArray(groups)) return null;
  const decoded = new Map<string, AntigravityQuotaGroup>();
  for (const group of groups) {
    if (!isObject(group) || typeof group.name !== "string" || !Array.isArray(group.buckets))
      continue;
    const windows = new Map<string, QuotaWindow>();
    for (const bucket of group.buckets) {
      if (!isObject(bucket) || typeof bucket.id !== "string" || typeof bucket.window !== "string") {
        continue;
      }
      const fraction = bucket.remaining_fraction;
      const reset = bucket.reset_time;
      windows.set(bucket.id, {
        id: bucket.id,
        label: typeof bucket.name === "string" ? bucket.name : bucket.window,
        remaining: typeof fraction === "number" && fraction >= 0 && fraction <= 1 ? fraction : null,
        resetsAt:
          typeof reset === "string" &&
          /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(reset) &&
          Number.isFinite(Date.parse(reset))
            ? reset
            : null,
      });
    }
    if (windows.size > 0)
      decoded.set(group.name, { name: group.name, windows: [...windows.values()] });
  }
  return decoded.size > 0 ? [...decoded.values()] : null;
}

export function parseAntigravityQuotaReport(text: string): readonly AntigravityQuotaGroup[] | null {
  if (text.length > MAX_REPORT_LENGTH) return null;
  let result: readonly AntigravityQuotaGroup[] | null = null;
  let start = 0;
  let depth = 0;
  let inString = false;
  // A terminal selection can include the command line and the following shell prompt.
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      if (character === "\\") index++;
      else if (character === '"') inString = false;
    } else if (character === "{") {
      if (depth === 0) start = index;
      depth++;
    } else if (depth > 0) {
      if (character === '"') inString = true;
      if (character === "}" && --depth === 0) {
        const report = decodeReport(text.slice(start, index + 1));
        if (!report) continue;
        if (result) return null;
        result = report;
      }
    }
  }
  return result;
}
