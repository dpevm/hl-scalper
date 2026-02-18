#!/usr/bin/env node
/**
 * Hyperliquid 5-Min Scalper — BTC, ETH, HYPE
 * Momentum-based scalping with cross-coin confirmation.
 *
 * Usage:
 *   node hl_scalper.mjs              # DRY RUN (default)
 *   node hl_scalper.mjs --live       # LIVE TRADING
 */
import { Hyperliquid } from 'hyperliquid';

// ============================================================
// CONFIG
// ============================================================
const COINS = ['BTC', 'ETH', 'HYPE'];
const COIN_PERP = { BTC: 'BTC-PERP', ETH: 'ETH-PERP', HYPE: 'HYPE-PERP' };
const SZ_DECIMALS = { BTC: 5, ETH: 4, HYPE: 2 };
const INTERVAL = '5m';
const LOOKBACK_CANDLES = 12;
const POLL_INTERVAL_MS = 30000;
const LEVERAGE = 5;
const MAX_POSITION_PCT = 0.30;
const MAX_POSITIONS = 2;
const STOP_LOSS_PCT = 0.015;
const TAKE_PROFIT_PCT = 0.025;
const MIN_CONFIDENCE = 0.65;       // raised — don't trade weak signals
const TAKER_FEE_PCT = 0.00045;     // 0.045% taker per side
const MAKER_FEE_PCT = 0.00015;     // 0.015% maker per side
const COOLDOWN_MS = 300000;

const DRY_RUN = !process.argv.includes('--live');
const pk = process.env.HYPERLIQUID_PRIVATE_KEY;
if (!pk && !DRY_RUN) { console.error('Set HYPERLIQUID_PRIVATE_KEY'); process.exit(1); }

// ============================================================
// STATE
// ============================================================
const positions = {};   // coin -> { side, entry, size, time }
const cooldowns = {};   // coin -> timestamp
let totalPnl = 0;
let tradeCount = 0;
let winCount = 0;
let sdk;

// ============================================================
// HELPERS
// ============================================================
function log(msg, level = 'INFO') {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  const prefix = { INFO: '📊', TRADE: '⚡', SIGNAL: '🎯', WARN: '⚠️', EXIT: '🚪' }[level] || '';
  console.log(`[${ts}] ${prefix} ${msg}`);
}

function toSigFigs(n, sf = 5) {
  if (n === 0) return '0';
  const d = Math.ceil(Math.log10(Math.abs(n)));
  const power = sf - d;
  const mag = Math.pow(10, power);
  return String(Math.round(n * mag) / mag);
}

function roundSize(coin, size) {
  const dec = SZ_DECIMALS[coin] || 2;
  return parseFloat(size.toFixed(dec));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// API
// ============================================================
async function getCandles(coin, n = LOOKBACK_CANDLES) {
  const nowMs = Date.now();
  const startMs = nowMs - (n * 5 * 60 * 1000 + 60000);
  try {
    const resp = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'candleSnapshot',
        req: { coin, interval: INTERVAL, startTime: startMs, endTime: nowMs }
      })
    });
    const candles = await resp.json();
    return candles.slice(-n);
  } catch (e) {
    log(`Error fetching candles for ${coin}: ${e.message}`, 'WARN');
    return [];
  }
}

const WALLET_ADDRESS = process.env.HYPERLIQUID_WALLET || '0xa6c00709b5b2a78424ce6880fdda87b9fc1ffe4b';

async function getBalance() {
  try {
    const resp = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'clearinghouseState', user: WALLET_ADDRESS })
    });
    const state = await resp.json();
    return parseFloat(state.marginSummary?.accountValue || '0');
  } catch (e) {
    log(`Balance error: ${e.message}`, 'WARN');
    return 0;
  }
}

async function getMids() {
  const mids = await sdk.info.getAllMids();
  const result = {};
  for (const coin of COINS) {
    const key = COIN_PERP[coin];
    if (mids[key]) result[coin] = parseFloat(mids[key]);
  }
  return result;
}

/**
 * Place order. mode='market' = IOC taker, mode='limit' = GTC maker (rests on book).
 * For entries we use limit (cheaper). For exits we use market (guaranteed).
 */
async function placeOrder(side, size, coin, reduceOnly = false, mode = 'market') {
  if (DRY_RUN) {
    log(`[DRY RUN] Would ${side} ${size} ${coin} (${mode})`, 'TRADE');
    return true;
  }
  try {
    const isBuy = side === 'buy';
    const mids = await sdk.info.getAllMids();
    const price = parseFloat(mids[COIN_PERP[coin]]);

    let limitPx, orderType;
    if (mode === 'limit') {
      // Post-only limit: place AT current mid price to sit on book as maker
      // Slightly favorable to ensure it rests (buy just below mid, sell just above)
      limitPx = toSigFigs(isBuy ? price * 0.9999 : price * 1.0001);
      orderType = { limit: { tif: 'Alo' } }; // Add Liquidity Only (maker only)
    } else {
      // Market: IOC with 3% slippage
      limitPx = toSigFigs(isBuy ? price * 1.03 : price * 0.97);
      orderType = { limit: { tif: 'Ioc' } };
    }

    const result = await sdk.exchange.placeOrder({
      coin: COIN_PERP[coin],
      is_buy: isBuy,
      sz: size,
      limit_px: limitPx,
      order_type: orderType,
      reduce_only: reduceOnly,
    });

    const status = result?.response?.data?.statuses?.[0];
    if (status?.filled) {
      log(`Filled ${side} ${size} ${coin} @ $${status.filled.avgPx} (${mode})`, 'TRADE');
      return parseFloat(status.filled.avgPx);
    } else if (status?.resting) {
      log(`Resting ${side} ${size} ${coin} @ $${limitPx} (maker limit, oid=${status.resting.oid})`, 'TRADE');
      return { resting: true, oid: status.resting.oid, price: parseFloat(limitPx) };
    } else if (status?.error) {
      log(`Order error: ${status.error}`, 'WARN');
      return false;
    }
    log(`Order result: ${JSON.stringify(result)}`, 'TRADE');
    return false;
  } catch (e) {
    log(`Order failed: ${e.message}`, 'WARN');
    return false;
  }
}

async function setLeverage(coin, lev) {
  try {
    await sdk.exchange.updateLeverage(COIN_PERP[coin], 'cross', lev);
    log(`Set ${coin} leverage to ${lev}x cross`);
  } catch (e) {
    log(`Leverage error ${coin}: ${e.message}`, 'WARN');
  }
}

// ============================================================
// INDICATORS
// ============================================================
function computeIndicators(candles) {
  if (candles.length < 6) return null;

  const closes = candles.map(c => parseFloat(c.c));
  const highs = candles.map(c => parseFloat(c.h));
  const lows = candles.map(c => parseFloat(c.l));
  const volumes = candles.map(c => parseFloat(c.v));

  const recentAvg = closes.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const priorAvg = closes.slice(-6, -3).reduce((a, b) => a + b, 0) / 3;
  const momentum = (recentAvg - priorAvg) / priorAvg;

  // RSI (6-period)
  const gains = [], losses = [];
  for (let i = 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    gains.push(Math.max(delta, 0));
    losses.push(Math.max(-delta, 0));
  }
  const avgGain = gains.slice(-6).reduce((a, b) => a + b, 0) / 6 || 0.001;
  const avgLoss = losses.slice(-6).reduce((a, b) => a + b, 0) / 6 || 0.001;
  const rsi = 100 - (100 / (1 + avgGain / avgLoss));

  // ATR (6-period)
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    trs.push(tr);
  }
  const atr = trs.slice(-6).reduce((a, b) => a + b, 0) / 6 || 0;
  const atrPct = atr / closes.at(-1);

  // Volume trend
  const recentVol = volumes.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const priorVol = volumes.slice(-6, -3).reduce((a, b) => a + b, 0) / 3 || recentVol;
  const volRatio = recentVol / Math.max(priorVol, 0.0001);

  return { price: closes.at(-1), momentum, rsi, atr, atrPct, volRatio };
}

function generateSignal(ind) {
  if (!ind) return null;
  if (ind.atrPct > 0.005) return null; // skip high vol

  let confidence = 0;
  let direction = null;

  if (ind.momentum > 0.0005) {
    confidence += 0.25; direction = 'buy';
    if (ind.rsi < 60) confidence += 0.15;
    if (ind.rsi < 45) confidence += 0.15;
    if (ind.volRatio > 1.1) confidence += 0.15;
    if (ind.momentum > 0.001) confidence += 0.15;
  } else if (ind.momentum < -0.0005) {
    confidence += 0.25; direction = 'sell';
    if (ind.rsi > 40) confidence += 0.15;
    if (ind.rsi > 55) confidence += 0.15;
    if (ind.volRatio > 1.1) confidence += 0.15;
    if (ind.momentum < -0.001) confidence += 0.15;
  }

  if (!direction || confidence < MIN_CONFIDENCE) return null;
  return { direction, confidence, ...ind };
}

function crossCoinConfirm(signals) {
  const dirs = {};
  for (const [coin, sig] of Object.entries(signals)) if (sig) dirs[coin] = sig.direction;
  if (Object.keys(dirs).length < 2) return signals;

  const longs = Object.values(dirs).filter(d => d === 'buy').length;
  const shorts = Object.values(dirs).filter(d => d === 'sell').length;
  const majority = longs > shorts ? 'buy' : shorts > longs ? 'sell' : null;

  if (majority) {
    for (const [coin, sig] of Object.entries(signals)) {
      if (!sig) continue;
      if (sig.direction === majority) {
        sig.confidence = Math.min(sig.confidence + 0.10, 0.95);
        sig.confirmed = true;
      } else {
        sig.confidence *= 0.7;
        sig.confirmed = false;
      }
    }
  }
  return signals;
}

// ============================================================
// POSITION MANAGEMENT
// ============================================================
function computeSize(coin, price, balance) {
  const maxNotional = balance * LEVERAGE * MAX_POSITION_PCT;
  let size = maxNotional / price;
  size = roundSize(coin, size);
  if (size * price < 10) return 0; // $10 min notional
  return size;
}

async function checkExits(coin, currentPrice) {
  if (!positions[coin]) return;
  const pos = positions[coin];
  const pnlPct = pos.side === 'buy'
    ? (currentPrice - pos.entry) / pos.entry
    : (pos.entry - currentPrice) / pos.entry;

  const exitSide = pos.side === 'buy' ? 'sell' : 'buy';

  // Skip pending (unfilled limit) orders for exit checks
  if (pos.pending) return;

  if (pnlPct <= -STOP_LOSS_PCT) {
    const exitNotional = pos.size * currentPrice;
    const exitFee = exitNotional * TAKER_FEE_PCT;  // exits always taker
    const pnlUsd = pos.size * currentPrice * pnlPct * LEVERAGE - exitFee;
    log(`STOP LOSS ${coin}: entry=$${pos.entry.toFixed(2)} exit=$${currentPrice.toFixed(2)} pnl=${(pnlPct * 100).toFixed(2)}% ($${pnlUsd.toFixed(2)} net)`, 'EXIT');
    await placeOrder(exitSide, pos.size, coin, true, 'market');
    totalPnl += pnlUsd;
    tradeCount++;
    delete positions[coin];
    cooldowns[coin] = Date.now() + COOLDOWN_MS;
  } else if (pnlPct >= TAKE_PROFIT_PCT) {
    const exitNotional = pos.size * currentPrice;
    const exitFee = exitNotional * TAKER_FEE_PCT;
    const pnlUsd = pos.size * currentPrice * pnlPct * LEVERAGE - exitFee;
    log(`TAKE PROFIT ${coin}: entry=$${pos.entry.toFixed(2)} exit=$${currentPrice.toFixed(2)} pnl=${(pnlPct * 100).toFixed(2)}% ($${pnlUsd.toFixed(2)} net)`, 'EXIT');
    await placeOrder(exitSide, pos.size, coin, true, 'market');
    totalPnl += pnlUsd;
    tradeCount++;
    winCount++;
    delete positions[coin];
    cooldowns[coin] = Date.now() + COOLDOWN_MS;
  }
}

// ============================================================
// MAIN
// ============================================================
async function run() {
  const mode = DRY_RUN ? '🔴 DRY RUN' : '🟢 LIVE';
  log(`=== HL 5-Min Scalper === ${mode}`);
  log(`Coins: ${COINS.join(', ')} | ${LEVERAGE}x | SL: ${STOP_LOSS_PCT * 100}% | TP: ${TAKE_PROFIT_PCT * 100}%`);

  sdk = new Hyperliquid({ privateKey: pk || undefined, enableWs: false });

  let balance = await getBalance();
  log(`Balance: $${balance.toFixed(2)} | Max notional/pos: $${(balance * MAX_POSITION_PCT * LEVERAGE).toFixed(2)}`);

  if (balance < 10) { log('Balance too low (<$10). Exiting.', 'WARN'); return; }

  if (!DRY_RUN) {
    for (const coin of COINS) await setLeverage(coin, LEVERAGE);
  }

  let cycle = 0;
  const shutdown = async () => {
    log('Shutting down...');
    for (const [coin, pos] of Object.entries(positions)) {
      const exitSide = pos.side === 'buy' ? 'sell' : 'buy';
      log(`Closing ${coin} position`, 'EXIT');
      await placeOrder(exitSide, pos.size, coin, true);
    }
    const wr = tradeCount > 0 ? `${(winCount / tradeCount * 100).toFixed(0)}%` : 'n/a';
    log(`=== Done === Trades: ${tradeCount} | WR: ${wr} | PnL: $${totalPnl.toFixed(2)}`);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  while (true) {
    try {
      cycle++;
      if (cycle % 10 === 1) balance = await getBalance();

      // Check pending limit orders — did they fill?
      for (const [coin, pos] of Object.entries(positions)) {
        if (!pos.pending) continue;
        try {
          const resp = await fetch('https://api.hyperliquid.xyz/info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'orderStatus', user: WALLET_ADDRESS, oid: pos.oid })
          });
          const data = await resp.json();
          const status = data?.order?.status;
          if (status === 'filled') {
            pos.pending = false;
            log(`Limit FILLED ${coin} oid=${pos.oid}`, 'TRADE');
          } else if (Date.now() - pos.time > 60000) {
            // Cancel after 60s if unfilled — market moved away
            await sdk.exchange.cancelOrder({ coin: COIN_PERP[coin], o: pos.oid });
            log(`Cancelled stale limit ${coin} oid=${pos.oid}`, 'WARN');
            delete positions[coin];
          }
        } catch (e) {
          log(`Order status check failed: ${e.message}`, 'WARN');
        }
      }

      const signals = {};
      const prices = await getMids();

      for (const coin of COINS) {
        const candles = await getCandles(coin);
        if (!candles.length) continue;

        const ind = computeIndicators(candles);
        if (!ind) continue;

        // Use live price from mids if available
        const livePrice = prices[coin] || ind.price;
        await checkExits(coin, livePrice);

        const sig = generateSignal(ind);
        if (sig) { sig.price = livePrice; signals[coin] = sig; }
      }

      crossCoinConfirm(signals);

      let activeCount = Object.keys(positions).length;
      const sorted = Object.entries(signals).sort((a, b) => b[1].confidence - a[1].confidence);

      for (const [coin, sig] of sorted) {
        if (activeCount >= MAX_POSITIONS) break;
        if (positions[coin]) continue;
        if (cooldowns[coin] && Date.now() < cooldowns[coin]) continue;
        if (sig.confidence < MIN_CONFIDENCE) continue;

        const size = computeSize(coin, sig.price, balance);
        if (size <= 0) continue;

        const conf = sig.confirmed ? '✓confirmed' : '';
        log(`SIGNAL ${coin}: ${sig.direction.toUpperCase()} conf=${(sig.confidence * 100).toFixed(0)}% ` +
            `mom=${(sig.momentum * 100).toFixed(3)}% rsi=${sig.rsi.toFixed(1)} vol_r=${sig.volRatio.toFixed(2)} ${conf}`, 'SIGNAL');

        // Use ALO (maker) limit for entries — 0.015% vs 0.045% taker
        const fillResult = await placeOrder(sig.direction, size, coin, false, 'limit');
        if (fillResult) {
          let entry, entryFee;
          if (typeof fillResult === 'object' && fillResult.resting) {
            // Order is resting on book — track as pending
            entry = fillResult.price;
            entryFee = size * entry * MAKER_FEE_PCT;
            positions[coin] = { side: sig.direction, entry, size, time: Date.now(), confidence: sig.confidence, oid: fillResult.oid, pending: true };
          } else {
            entry = typeof fillResult === 'number' ? fillResult : sig.price;
            entryFee = size * entry * MAKER_FEE_PCT;
            positions[coin] = { side: sig.direction, entry, size, time: Date.now(), confidence: sig.confidence };
          }
          const notional = size * entry;
          totalPnl -= entryFee;
          activeCount++;
          log(`OPENED ${sig.direction.toUpperCase()} ${size} ${coin} @ $${entry.toFixed(2)} ($${notional.toFixed(2)} notional, ${LEVERAGE}x) fee=$${entryFee.toFixed(4)}`, 'TRADE');
        }
      }

      const posStr = Object.entries(positions).map(([c, p]) => `${c}:${p.side[0].toUpperCase()}`).join(' | ') || 'none';
      const wr = tradeCount > 0 ? `${(winCount / tradeCount * 100).toFixed(0)}%` : 'n/a';
      log(`[cycle ${cycle}] bal=$${balance.toFixed(2)} pos=[${posStr}] trades=${tradeCount} wr=${wr} pnl=$${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}`);

      await sleep(POLL_INTERVAL_MS);
    } catch (e) {
      log(`Error: ${e.message}`, 'WARN');
      await sleep(10000);
    }
  }
}

run().catch(e => { console.error(e); process.exit(1); });
