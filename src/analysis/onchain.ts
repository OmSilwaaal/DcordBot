import { config } from '../config.js';
import type { OnchainCheck } from '../types.js';
import { fetchJson } from '../utils/http.js';
import { RateLimiter } from '../utils/limiter.js';
import { sum } from '../utils/math.js';

const limiter = new RateLimiter(config.feeds.rpcRps, Math.max(2, config.feeds.rpcRps));

/** Token-2022 extensions that let the issuer block sells, seize tokens, or tax transfers. */
const DANGEROUS_EXTENSIONS = new Set([
  'permanentDelegate',
  'transferHook',
  'nonTransferable',
  'pausableConfig',
]);

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetchJson<{ result?: T; error?: { message: string } }>(config.feeds.rpcUrl, {
    method: 'POST',
    body: { jsonrpc: '2.0', id: 1, method, params },
    limiter,
    retries: 1,
    timeoutMs: 8000,
  });
  if (!r.ok || !r.data) throw new Error(`${method}: ${r.error ?? 'no response'}`);
  if (r.data.error) throw new Error(`${method}: ${r.data.error.message}`);
  return r.data.result as T;
}

interface ParsedMint {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supply: string;
  decimals: number;
  extensions?: { extension: string; state?: Record<string, any> }[];
}

function dangerousExtensions(exts: ParsedMint['extensions']): string[] {
  const out: string[] = [];
  for (const e of exts ?? []) {
    if (DANGEROUS_EXTENSIONS.has(e.extension)) out.push(e.extension);
    if (e.extension === 'transferFeeConfig') {
      const bps = Number(e.state?.newerTransferFee?.transferFeeBasisPoints ?? e.state?.olderTransferFee?.transferFeeBasisPoints ?? 0);
      if (bps > 0) out.push(`transferFee ${bps / 100}%`);
    }
    if (e.extension === 'defaultAccountState' && e.state?.accountState === 'frozen') out.push('defaultFrozen');
  }
  return out;
}

/**
 * Direct on-chain verification at signal time:
 *  - mint / freeze authority revoked (can't print supply or freeze your tokens)
 *  - no sell-blocking Token-2022 extensions (the actual honeypot check)
 *  - real top-holder concentration, excluding the bonding-curve account.
 *    This catches supply moved by transfer, which the trade stream can't see.
 */
export async function onchainCheck(mint: string, bondingCurveKey: string): Promise<OnchainCheck> {
  const empty: OnchainCheck = {
    ok: false,
    mintAuthority: null,
    freezeAuthority: null,
    dangerousExtensions: [],
    top10Pct: 0,
    maxHolderPct: 0,
  };
  try {
    const info = await rpc<{ value: { owner: string; data: { parsed?: { info?: ParsedMint } } } | null }>(
      'getAccountInfo',
      [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }],
    );
    const m = info.value?.data?.parsed?.info;
    if (!m) throw new Error('mint account missing or unparsed');
    const supply = Number(m.supply) / 10 ** m.decimals;
    if (!(supply > 0)) throw new Error('zero supply');

    const largest = await rpc<{ value: { address: string; uiAmount: number | null; uiAmountString?: string }[] }>(
      'getTokenLargestAccounts',
      [mint, { commitment: 'confirmed' }],
    );
    const accts = largest.value ?? [];
    const owners =
      accts.length > 0
        ? await rpc<{ value: ({ data: { parsed?: { info?: { owner?: string } } } } | null)[] }>(
            'getMultipleAccounts',
            [accts.map((a) => a.address), { encoding: 'jsonParsed', commitment: 'confirmed' }],
          )
        : { value: [] };

    const holders: number[] = [];
    accts.forEach((a, i) => {
      const amt = a.uiAmount ?? Number(a.uiAmountString ?? 0);
      if (!(amt > 0)) return;
      const owner = owners.value?.[i]?.data?.parsed?.info?.owner;
      const isCurve = bondingCurveKey ? owner === bondingCurveKey : i === 0 && amt / supply > 0.5;
      if (!isCurve) holders.push(amt);
    });
    holders.sort((a, b) => b - a);

    return {
      ok: true,
      tokenProgram: info.value?.owner,
      mintAuthority: m.mintAuthority ?? null,
      freezeAuthority: m.freezeAuthority ?? null,
      dangerousExtensions: dangerousExtensions(m.extensions),
      top10Pct: (sum(holders.slice(0, 10)) / supply) * 100,
      maxHolderPct: ((holders[0] ?? 0) / supply) * 100,
    };
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : String(e) };
  }
}
