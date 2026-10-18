/**
 * Registry of runtime flags /ops/functions can switch (otto/mamoru#129, migration 0012 in ottodevs/mamoru).
 * A copy of the names in ottodevs/mamoru's `packages/policy/src/ops-flags.ts`, kept here because this repo
 * does not share packages with it (same reason engine-settings-model.ts copies spec 006's model). The copy
 * only drives the page; the app Worker and the operator read the row this page writes, nothing here. The
 * label and the operator-facing cost note are the copy agreed for this console, not a restatement of the
 * registry's own description.
 */

export type OpsFlagName = "yield_ledger";

export interface OpsFlagDef {
  label: string;
  description: string;
}

export const OPS_FLAGS: Record<OpsFlagName, OpsFlagDef> = {
  yield_ledger: {
    label: "Yield ledger",
    description:
      "The operator reads every Safe every 30 s and the app Worker stores daily rows per account and position. Costs roughly 3–5k RPC CU/h.",
  },
};

export const OPS_FLAG_NAMES: readonly OpsFlagName[] = Object.keys(OPS_FLAGS) as OpsFlagName[];

export function isOpsFlagName(value: string): value is OpsFlagName {
  return Object.hasOwn(OPS_FLAGS, value);
}
