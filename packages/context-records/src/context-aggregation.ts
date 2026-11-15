import { assertContextPolicy } from "./context-policy.js";
import {
  contextSourceKey,
  type ContextRecord,
  type ContextSource,
} from "./context-sources.js";

export type ContextRecordDisposition = "current" | "superseded";
export type ContextSupersessionReason =
  | "newer-derived-record"
  | "duplicate-derived-content"
  | "duplicate-source-content";

export interface ContextChronologyEntry {
  record: ContextRecord;
  disposition: ContextRecordDisposition;
  position: number;
  supersededByPosition?: number;
  reason?: ContextSupersessionReason;
}

export interface ContextSourceGroup {
  key: string;
  source: ContextSource;
  chronology: readonly ContextChronologyEntry[];
  current: readonly ContextRecord[];
}

export interface ContextAggregation {
  groups: readonly ContextSourceGroup[];
  currentRecords: readonly ContextRecord[];
}

/**
 * Groups context by stable source identity without discarding chronology.
 * Newer derived records supersede older derived text, and exact duplicates
 * collapse. Changed canonical and observed records remain current so aggregation
 * cannot silently erase authored or durable facts.
 */
export function aggregateContextRecords(
  records: readonly ContextRecord[],
): ContextAggregation {
  const grouped = new Map<string, Array<{ record: ContextRecord; inputPosition: number }>>();
  records.forEach((record, inputPosition) => {
    assertContextPolicy(record);
    const key = contextSourceKey(record.source);
    const values = grouped.get(key) ?? [];
    values.push({ record, inputPosition });
    grouped.set(key, values);
  });

  const groups = [...grouped.entries()].map(([key, values]) => {
    values.sort(compareChronology);
    const newestDerivedPosition = findNewestDerivedPosition(values);
    const newestEquivalentPositions = findNewestEquivalentPositions(values);
    const chronology = values.map(({ record }, position): ContextChronologyEntry => {
      const equivalentPosition = newestEquivalentPositions.get(recordContentKey(record));
      if (equivalentPosition !== undefined && equivalentPosition !== position) {
        return {
          record,
          disposition: "superseded",
          position,
          supersededByPosition: equivalentPosition,
          reason: record.provenance === "derived"
            ? "duplicate-derived-content"
            : "duplicate-source-content",
        };
      }
      if (
        record.provenance === "derived" &&
        newestDerivedPosition !== undefined &&
        position !== newestDerivedPosition
      ) {
        return {
          record,
          disposition: "superseded",
          position,
          supersededByPosition: newestDerivedPosition,
          reason: "newer-derived-record",
        };
      }
      return { record, disposition: "current", position };
    });
    const current = chronology
      .filter((entry) => entry.disposition === "current")
      .map((entry) => entry.record);
    const latest = values.at(-1)?.record;
    if (!latest) throw new Error(`Context group ${key} is empty`);
    return {
      key,
      source: latest.source,
      chronology,
      current,
    } satisfies ContextSourceGroup;
  });

  groups.sort((left, right) =>
    newestTimestamp(right) - newestTimestamp(left) || left.key.localeCompare(right.key)
  );
  const currentRecords = groups
    .flatMap((group) => group.current)
    .sort((left, right) =>
      right.updatedAt - left.updatedAt ||
      contextSourceKey(left.source).localeCompare(contextSourceKey(right.source)) ||
      left.id.localeCompare(right.id)
    );
  return { groups, currentRecords };
}

function compareChronology(
  left: { record: ContextRecord; inputPosition: number },
  right: { record: ContextRecord; inputPosition: number },
): number {
  return left.record.updatedAt - right.record.updatedAt ||
    left.inputPosition - right.inputPosition;
}

function findNewestDerivedPosition(
  values: readonly { record: ContextRecord }[],
): number | undefined {
  for (let position = values.length - 1; position >= 0; --position) {
    if (values[position]?.record.provenance === "derived") return position;
  }
  return undefined;
}

function findNewestEquivalentPositions(
  values: readonly { record: ContextRecord }[],
): ReadonlyMap<string, number> {
  const positions = new Map<string, number>();
  for (let position = values.length - 1; position >= 0; --position) {
    const record = values[position]?.record;
    if (!record) continue;
    const key = recordContentKey(record);
    if (!positions.has(key)) positions.set(key, position);
  }
  return positions;
}

function recordContentKey(record: ContextRecord): string {
  return JSON.stringify({
    category: record.category,
    provenance: record.provenance,
    title: record.title.text,
    statements: statementsKey(record),
  });
}

function statementsKey(record: ContextRecord): string {
  return JSON.stringify(record.statements.map((statement) => ({
    role: statement.role,
    text: statement.text,
    sources: statement.sources.map(contextSourceKey),
  })));
}

function newestTimestamp(group: ContextSourceGroup): number {
  return group.chronology.at(-1)?.record.updatedAt ?? 0;
}
