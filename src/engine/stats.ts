import type { RawStats } from './exploit.js'

export type PlayerTag = 'FISH' | 'MANIAC' | 'NIT' | 'REG' | 'UNKNOWN'

export function computeTag(stats: RawStats): PlayerTag {
  if (stats.vpip_denom < 5) return 'UNKNOWN'

  const vpip = stats.vpip_num / stats.vpip_denom
  const pfr = stats.pfr_denom > 0 ? stats.pfr_num / stats.pfr_denom : 0

  if (vpip > 0.40 && pfr > 0.30) return 'MANIAC'
  if (vpip > 0.40) return 'FISH'
  if (vpip < 0.15) return 'NIT'
  return 'REG'
}

export function computeVpip(stats: RawStats): number | null {
  if (stats.vpip_denom === 0) return null
  return stats.vpip_num / stats.vpip_denom
}

export function computePfr(stats: RawStats): number | null {
  if (stats.pfr_denom === 0) return null
  return stats.pfr_num / stats.pfr_denom
}

export function computeAf(stats: RawStats): number | null {
  if (stats.af_calls === 0) return null
  return stats.af_bets / stats.af_calls
}

export function computeFoldToCbet(stats: RawStats): number | null {
  if (stats.cbet_fold_denom === 0) return null
  return stats.cbet_fold_num / stats.cbet_fold_denom
}

export function computeFoldTo3bet(stats: RawStats): number | null {
  if (stats.fold_to_3bet_denom === 0) return null
  return stats.fold_to_3bet_num / stats.fold_to_3bet_denom
}

export function computeWtsd(stats: RawStats): number | null {
  if (stats.wtsd_denom === 0) return null
  return stats.wtsd_num / stats.wtsd_denom
}

export function confidenceLabel(sampleSize: number): string {
  if (sampleSize < 5) return 'Low confidence (new player)'
  if (sampleSize < 30) return 'Medium confidence'
  return 'High confidence'
}
