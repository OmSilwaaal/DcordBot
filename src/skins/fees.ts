/**
 * Marketplace fee table. Sources conflict and fees change, so every value is
 * overridable from the environment and should be re-checked monthly.
 * Values are fractions (0.08 = 8%).
 */
export interface Venue {
  /** Fee taken from the seller on a sale. */
  sellFee: number;
  /** Fee taken when turning the balance into cash. */
  cashoutFee: number;
  /** Fee added on top when buying. */
  buyFee: number;
}

function frac(key: string, def: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n >= 1) throw new Error(`Env var ${key} must be a fraction in [0,1), got "${v}"`);
  return n;
}

export const VENUES = {
  skinport: { sellFee: frac('FEE_SKINPORT_SELL', 0.08), cashoutFee: frac('FEE_SKINPORT_CASHOUT', 0), buyFee: 0 },
  csfloat: { sellFee: frac('FEE_CSFLOAT_SELL', 0.02), cashoutFee: frac('FEE_CSFLOAT_CASHOUT', 0.025), buyFee: 0 },
  steam: { sellFee: frac('FEE_STEAM_SELL', 0.15), cashoutFee: 0, buyFee: 0 },
} satisfies Record<string, Venue>;

export type VenueName = keyof typeof VENUES;

/** What you actually keep from selling at `price` on `venue`. */
export function netProceeds(price: number, venue: VenueName): number {
  const v = VENUES[venue];
  return price * (1 - v.sellFee) * (1 - v.cashoutFee);
}

/** net edge = net sale proceeds / (buy price + buy fees) - 1 */
export function netEdge(buyPrice: number, salePrice: number, buyVenue: VenueName, sellVenue: VenueName): number {
  const cost = buyPrice * (1 + VENUES[buyVenue].buyFee);
  return netProceeds(salePrice, sellVenue) / cost - 1;
}

/** Gross spread needed just to break even on a sale venue. */
export function breakEvenSpread(venue: VenueName): number {
  const v = VENUES[venue];
  return 1 / ((1 - v.sellFee) * (1 - v.cashoutFee)) - 1;
}
