import { xdr, scValToNative } from '@stellar/stellar-sdk';
import { OnChainMilestone } from '../services/stellar';

/** Decodes an `xdr.ScVal` of type `scvBool` to a native boolean; throws if the type doesn't match. */
export function parseBoolean(val: xdr.ScVal): boolean {
  if (val.switch() !== xdr.ScValType.scvBool()) {
    throw new Error(`Expected scvBool, got ${val.switch().name}`);
  }
  return scValToNative(val) as boolean;
}

/** Decodes an `xdr.ScVal` of type `scvU128` or `scvI128` to a native bigint; throws if the type doesn't match. */
export function parseU128(val: xdr.ScVal): bigint {
  const type = val.switch();
  if (type !== xdr.ScValType.scvU128() && type !== xdr.ScValType.scvI128()) {
    throw new Error(`Expected scvU128 or scvI128, got ${type.name}`);
  }
  return BigInt(scValToNative(val) as string | number);
}

/** Decodes an `xdr.ScVal` vector of milestone map entries into `OnChainMilestone[]`; throws if the shape doesn't match. */
export function parseMilestones(val: xdr.ScVal): OnChainMilestone[] {
  if (val.switch() !== xdr.ScValType.scvVec()) {
    throw new Error(`Expected scvVec, got ${val.switch().name}`);
  }
  const items = val.vec() ?? [];
  return items.map((item) => {
    if (item.switch() !== xdr.ScValType.scvMap()) {
      throw new Error(`Expected scvMap for milestone entry, got ${item.switch().name}`);
    }
    const map = Object.fromEntries(
      (item.map() ?? []).map((e) => [
        scValToNative(e.key()) as string,
        scValToNative(e.val()),
      ])
    );
    return {
      milestoneId: String(map.milestone_id ?? ''),
      playerId: String(map.player_id ?? ''),
      milestoneType: String(map.milestone_type ?? ''),
      evidenceUri: String(map.evidence_uri ?? ''),
      approved: Boolean(map.approved),
      approvedBy: map.approved_by ? String(map.approved_by) : null,
      ledger: map.ledger != null ? Number(map.ledger) : null,
    } as OnChainMilestone;
  });
}

/** Decodes an `xdr.ScVal` of type `scvMap` into a subscription's active/expiresAt fields; throws if the type doesn't match. */
export function parseSubscription(val: xdr.ScVal): { active: boolean; expiresAt: string | null } {
  if (val.switch() !== xdr.ScValType.scvMap()) {
    throw new Error(`Expected scvMap, got ${val.switch().name}`);
  }
  const map = Object.fromEntries(
    (val.map() ?? []).map((e) => [
      scValToNative(e.key()) as string,
      scValToNative(e.val()),
    ])
  );
  return {
    active: Boolean(map.active),
    expiresAt: map.expires_at != null ? String(map.expires_at) : null,
  };
}
