import type { ContextRecord, ContextProvenance } from "./context-sources.js";

export type ContextPresentationKind =
  | "canonical-source"
  | "derived-annotation"
  | "observed-state";

export interface ContextPolicy {
  authority: ContextProvenance;
  presentation: ContextPresentationKind;
  label: "canonical source" | "derived annotation" | "observed state";
  checkoutWrite: "forbidden";
}

const policies: Record<ContextProvenance, ContextPolicy> = {
  canonical: {
    authority: "canonical",
    presentation: "canonical-source",
    label: "canonical source",
    checkoutWrite: "forbidden",
  },
  derived: {
    authority: "derived",
    presentation: "derived-annotation",
    label: "derived annotation",
    checkoutWrite: "forbidden",
  },
  observed: {
    authority: "observed",
    presentation: "observed-state",
    label: "observed state",
    checkoutWrite: "forbidden",
  },
};

export function contextPolicy(record: ContextRecord): ContextPolicy {
  assertContextPolicy(record);
  return policies[record.provenance];
}

export function assertContextPolicy(record: ContextRecord): void {
  const expected = expectedProvenance(record);
  if (record.provenance !== expected) {
    throw new Error(
      `Invalid ${record.category} context authority: expected ${expected}, received ${record.provenance}`,
    );
  }
}

function expectedProvenance(record: ContextRecord): ContextProvenance {
  switch (record.category) {
    case "document":
    case "commit":
      return "canonical";
    case "session-outcome":
      return "derived";
    case "change":
    case "branch":
    case "artifact":
      return "observed";
    default:
      return assertNever(record);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled context category: ${String(value)}`);
}
