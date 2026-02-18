#!/usr/bin/env node
/**
 * Hyperliquid RSI Divergence Scalper — BTC 1-min
 * 
 * Strategy: Detect extreme RSI divergences on 1-min candles.
 * - BULLISH: Price makes LOWER LOW but RSI(14) makes HIGHER LOW, RSI < 30
 * - BEARISH: Price makes HIGHER HIGH but RSI(14) makes LOWER HIGH, RSI > 70
 * 
 * These are high-probability mean-reversion setups. We enter on the divergence
 * and target a quick scalp back to the mean.
 *
 * Usage:
 *   node hl_rsi_divergence.mjs              # DRY RUN
 *   node hl_rsi_divergence.mjs --live       # LIVE
 */
import { Hyperliquid } from 'hyperliquid';

// ============================================================
// CONFIG
// ============================================================
const COIN = 'BTC';
const COIN_PERP = 'BTC-PERP';
const SZ_DECIMALS = 5;
const INTERVAL = '1m';
const LOOKBACK_CANDLES = 60;        // 1 hour of 1-min candles
const RSI_PERIOD = 14;
const RSI_OVERSOLD = 30;            // extreme low
const RSI_OVERBOUGHT = 70;          // extreme high
const PIVOT_LOOKBACK = 5;           // candles each side to confirm a pivot
const MAX_DIVERGENCE_SPAN = 20;     // max candles between two pivots for divergence
const POLL_INTERVAL_MS = 10000;     // check every 10 seconds
const LEVERAGE = 5;
const POSITION_PCT = 0.40;          // 40% of equity per trade
const STOP_LOSS_PCT = 0.008;        // 0.8% stop (tight — divergence should work fast)
const TAKE_PROFIT_PCT = 0.015;      // 1.5% take profit (nearly 2:1 R:R)
const TRAILING_ACTIVATE_PCT = 0.008; // activate trailing stop at 0.8% profit
const TRAILING_DISTANCE_PCT = 0.004; // trail by 0.4%
const COOLDOWN_MS = 120000;         // 2 min cooldown
const MAX_DAILY_LOSS = 2.00;        // circuit breaker
const BREAKEVEN_TIMEOUT_MS = 120000; // 2 min flat = close
const TAKER_FEE_PCT = 0.00045;
const MAKER_FEE_PCT = 0.00015;
const WALLET_ADDRESS = '0xa6c00709b5b2a78424ce6880fdda87b9fc1ffe4b';

const DRY_RUN = !process.argv.includes('--live');
const pk = process.env.HYPERLIQUID_PRIVATE_KEY;
if (!pk && !DRY_RUN) { console.error('Set HYPERLIQUID_PRIVATE_KEY'); process.exit(1); }

// ============================================================
// STATE
// ============================================================
let position = null;    // { side, entry, size, time, trailingStop, highWater }
let cooldownUntil = 0;
let totalPnl = 0;
let tradeCount = 0;
let winCount = 0;
let sdk;

// ============================================================
// HELPERS
// ============================================================
function log(msg, level = 'INFO') {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  const prefix = { INFO: '📊', TRADE: '⚡', SIGNAL: '🎯', WARN: '⚠️', EXIT: '🚪', DIV: '🔀' }[level] || '';
  console.log(`[${ts}] ${prefix} ${msg}`);
}

function toSigFigs(n, sf = 5) {
  if (n === 0) return '0';
  const d = Math.ceil(Math.log10(Math.abs(n)));
  const power = sf - d;
  const mag = Math.pow(10, power);
  return String(Math.round(n * mag) / mag);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// RSI CALCULATION
// ============================================================
function computeRSI(closes, period = RSI_PERIOD) {
  const rsiValues = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsiValues;

  let avgGain = 0, avgLoss = 0;
  // Initial average
  for (let i = 1; i <= period; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta > 0) avgGain += delta;
    else avgLoss += Math.abs(delta);
  }
  avgGain /= period;
  avgLoss /= period;

  rsiValues[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

  // Smoothed RSI
  for (let i = period + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? Math.abs(delta) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsiValues[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return rsiValues;
}

// ============================================================
// PIVOT DETECTION
// ============================================================
function findPivotLows(data, lookback = PIVOT_LOOKBACK) {
  const pivots = [];
  for (let i = lookback; i < data.length - lookback; i++) {
    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (data[i] > data[i - j] || data[i] > data[i + j]) { isLow = false; break; }
    }
    if (isLow) pivots.push({ index: i, value: data[i] });
  }
  return pivots;
}

function findPivotHighs(data, lookback = PIVOT_LOOKBACK) {
  const pivots = [];
  for (let i = lookback; i < data.length - lookback; i++) {
    let isHigh = true;
    for (let j = 1; j <= lookback; j++) {
      if (data[i] < data[i - j] || data[i] < data[i + j]) { isHigh = false; break; }
    }
    if (isHigh) pivots.push({ index: i, value: data[i] });
  }
  return pivots;
}

// ============================================================
// DIVERGENCE DETECTION
// ============================================================
function detectDivergences(closes, rsiValues) {
  const signals = [];

  // BULLISH DIVERGENCE: Price lower low + RSI higher low, RSI in oversold zone
  const priceLows = findPivotLows(closes);
  const rsiLows = findPivotLows(rsiValues.map(v => v ?? 100)); // treat null as high

  for (let i = 1; i < priceLows.length; i++) {
    const prevPL = priceLows[i - 1];
    const currPL = priceLows[i];
    const span = currPL.index - prevPL.index;
    if (span > MAX_DIVERGENCE_SPAN || span < 3) continue;

    // Price makes LOWER LOW
    if (currPL.value >= prevPL.value) continue;

    // Find corresponding RSI lows near these price pivots
    const prevRSI = findNearestPivot(rsiLows, prevPL.index, 3);
    const currRSI = findNearestPivot(rsiLows, currPL.index, 3);
    if (!prevRSI || !currRSI) continue;

    // RSI makes HIGHER LOW (divergence!)
    if (currRSI.value <= prevRSI.value) continue;

    // RSI must be in oversold zone
    if (currRSI.value > RSI_OVERSOLD) continue;

    signals.push({
      type: 'bullish',
      index: currPL.index,
      priceLevel: currPL.value,
      rsiLevel: currRSI.value,
      priceDrop: ((currPL.value - prevPL.value) / prevPL.value * 100).toFixed(3),
      rsiRise: (currRSI.value - prevRSI.value).toFixed(1),
    });
  }

  // BEARISH DIVERGENCE: Price higher high + RSI lower high, RSI in overbought zone
  const priceHighs = findPivotHighs(closes);
  const rsiHighs = findPivotHighs(rsiValues.map(v => v ?? 0)); // treat null as low

  for (let i = 1; i < priceHighs.length; i++) {
    const prevPH = priceHighs[i - 1];
    const currPH = priceHighs[i];
    const span = currPH.index - prevPH.index;
    if (span > MAX_DIVERGENCE_SPAN || span < 3) continue;

    // Price makes HIGHER HIGH
    if (currPH.value <= prevPH.value) continue;

    const prevRSI = findNearestPivot(rsiHighs, prevPH.index, 3);
    const currRSI = findNearestPivot(rsiHighs, currPH.index, 3);
    if (!prevRSI || !currRSI) continue;

    // RSI makes LOWER HIGH
    if (currRSI.value >= prevRSI.value) continue;

    // RSI must be in overbought zone
    if (currRSI.value < RSI_OVERBOUGHT) continue;

    signals.push({
      type: 'bearish',
      index: currPH.index,
      priceLevel: currPH.value,
      rsiLevel: currRSI.value,
      priceRise: ((currPH.value - prevPH.value) / prevPH.value * 100).toFixed(3),
      rsiDrop: (prevRSI.value - currRSI.value).toFixed(1),
    });
  }

  return signals;
}

function findNearestPivot(pivots, targetIndex, tolerance) {
  let best = null;
  for (const p of pivots) {
    if (Math.abs(p.index - targetIndex) <= tolerance) {
      if (!best || Math.abs(p.index - targetIndex) < Math.abs(best.index - targetIndex)) {
        best = p;
      }
    }
  }
  return best;
}

// ============================================================
// API
// ============================================================
async function getCandles(n = LOOKBACK_CANDLES) {
  const nowMs = Date.now();
  const startMs = nowMs - (n * 60 * 1000 + 60000);
  try {
    const resp = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'candleSnapshot',
        req: { coin: COIN, interval: INTERVAL, startTime: startMs, endTime: nowMs }
      })
    });
    return (await resp.json()).slice(-n);
  } catch (e) {
    log(`Candle fetch error: ${e.message}`, 'WARN');
    return [];
  }
}

async function getBalance() {
  try {
    const resp = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'clearinghouseState', user: WALLET_ADDRESS })
    });
    const state = await resp.json();
    return parseFloat(state.marginSummary?.accountValue || '0');
  } catch (e) { return 0; }
}

async function getMid() {
  try {
    const resp = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'allMids' })
    });
    const mids = await resp.json();
    return parseFloat(mids[COIN] || '0');
  } catch (e) { return 0; }
}

async function placeOrder(side, size, reduceOnly = false, mode = 'market') {
  if (DRY_RUN) {
    const price = await getMid();
    log(`[DRY RUN] ${side} ${size} ${COIN} @ ~$${price.toFixed(2)} (${mode})`, 'TRADE');
    return price;
  }
  try {
    const isBuy = side === 'buy';
    const mids = await sdk.info.getAllMids();
    const price = parseFloat(mids[COIN_PERP]);

    let limitPx, orderType;
    if (mode === 'limit') {
      limitPx = toSigFigs(isBuy ? price * 0.9999 : price * 1.0001);
      orderType = { limit: { tif: 'Alo' } };
    } else {
      limitPx = toSigFigs(isBuy ? price * 1.03 : price * 0.97);
      orderType = { limit: { tif: 'Ioc' } };
    }

    const result = await sdk.exchange.placeOrder({
      coin: COIN_PERP, is_buy: isBuy, sz: size,
      limit_px: limitPx, order_type: orderType, reduce_only: reduceOnly,
    });

    const status = result?.response?.data?.statuses?.[0];
    if (status?.filled) {
      log(`Filled ${side} ${size} ${COIN} @ $${status.filled.avgPx} (${mode})`, 'TRADE');
      return parseFloat(status.filled.avgPx);
    } else if (status?.resting) {
      return { resting: true, oid: status.resting.oid, price: parseFloat(limitPx) };
    } else if (status?.error) {
      log(`Order error: ${status.error}`, 'WARN');
    }
    return false;
  } catch (e) {
    log(`Order failed: ${e.message}`, 'WARN');
    return false;
  }
}

// ============================================================
// POSITION MANAGEMENT
// ============================================================
async function checkExits(currentPrice) {
  if (!position) return;

  const pnlPct = position.side === 'buy'
    ? (currentPrice - position.entry) / position.entry
    : (position.entry - currentPrice) / position.entry;

  const exitSide = position.side === 'buy' ? 'sell' : 'buy';
  const age = Date.now() - position.time;

  // Update high water mark for trailing stop
  if (pnlPct > (position.highWater || 0)) {
    position.highWater = pnlPct;
  }

  // Trailing stop: once profit exceeds activation threshold, trail it
  if (position.highWater >= TRAILING_ACTIVATE_PCT) {
    const trailLevel = position.highWater - TRAILING_DISTANCE_PCT;
    if (pnlPct <= trailLevel) {
      const notional = position.size * currentPrice;
      const fee = notional * TAKER_FEE_PCT;
      const pnlUsd = position.size * currentPrice * pnlPct * LEVERAGE - fee;
      log(`TRAILING STOP ${COIN}: peak=${(position.highWater*100).toFixed(2)}% exit=${(pnlPct*100).toFixed(2)}% ($${pnlUsd.toFixed(2)} net)`, 'EXIT');
      await placeOrder(exitSide, position.size, true);
      totalPnl += pnlUsd;
      tradeCount++;
      if (pnlUsd > 0) winCount++;
      position = null;
      cooldownUntil = Date.now() + COOLDOWN_MS;
      return;
    }
  }

  // Hard stop loss
  if (pnlPct <= -STOP_LOSS_PCT) {
    const notional = position.size * currentPrice;
    const fee = notional * TAKER_FEE_PCT;
    const pnlUsd = position.size * currentPrice * pnlPct * LEVERAGE - fee;
    log(`STOP LOSS ${COIN}: entry=$${position.entry.toFixed(2)} exit=$${currentPrice.toFixed(2)} (${(pnlPct*100).toFixed(2)}% / $${pnlUsd.toFixed(2)} net)`, 'EXIT');
    await placeOrder(exitSide, position.size, true);
    totalPnl += pnlUsd;
    tradeCount++;
    position = null;
    cooldownUntil = Date.now() + COOLDOWN_MS;
    return;
  }

  // Take profit
  if (pnlPct >= TAKE_PROFIT_PCT) {
    const notional = position.size * currentPrice;
    const fee = notional * TAKER_FEE_PCT;
    const pnlUsd = position.size * currentPrice * pnlPct * LEVERAGE - fee;
    log(`TAKE PROFIT ${COIN}: entry=$${position.entry.toFixed(2)} exit=$${currentPrice.toFixed(2)} (${(pnlPct*100).toFixed(2)}% / $${pnlUsd.toFixed(2)} net)`, 'EXIT');
    await placeOrder(exitSide, position.size, true);
    totalPnl += pnlUsd;
    tradeCount++;
    winCount++;
    position = null;
    cooldownUntil = Date.now() + COOLDOWN_MS;
    return;
  }

  // Breakeven timeout
  if (age > BREAKEVEN_TIMEOUT_MS && Math.abs(pnlPct) < 0.003) {
    const notional = position.size * currentPrice;
    const fee = notional * TAKER_FEE_PCT;
    const pnlUsd = position.size * currentPrice * pnlPct * LEVERAGE - fee;
    log(`TIMEOUT ${COIN}: flat after ${(age/1000).toFixed(0)}s ($${pnlUsd.toFixed(3)} net)`, 'EXIT');
    await placeOrder(exitSide, position.size, true);
    totalPnl += pnlUsd;
    tradeCount++;
    if (pnlUsd > 0) winCount++;
    position = null;
    cooldownUntil = Date.now() + COOLDOWN_MS;
  }
}

// ============================================================
// MAIN LOOP
// ============================================================
async function run() {
  const mode = DRY_RUN ? '🔴 DRY RUN' : '🟢 LIVE';
  log(`=== HL RSI Divergence Scalper === ${mode}`);
  log(`${COIN} 1-min | RSI(${RSI_PERIOD}) extremes: <${RSI_OVERSOLD} / >${RSI_OVERBOUGHT} | ${LEVERAGE}x | SL:${STOP_LOSS_PCT*100}% TP:${TAKE_PROFIT_PCT*100}%`);

  sdk = new Hyperliquid({ privateKey: pk || undefined, enableWs: false });

  let balance = await getBalance();
  if (balance === 0) {
    // Fallback: direct API
    try {
      const resp = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'clearinghouseState', user: WALLET_ADDRESS })
      });
      const state = await resp.json();
      balance = parseFloat(state.marginSummary?.accountValue || '0');
    } catch(e) { log(`Balance fallback failed: ${e.message}`, 'WARN'); }
  }
  log(`Balance: $${balance.toFixed(2)}`);
  if (balance < 10) { log('Balance too low', 'WARN'); return; }

  if (!DRY_RUN) {
    await sdk.exchange.updateLeverage(COIN_PERP, 'cross', LEVERAGE);
    log(`Set ${COIN} leverage to ${LEVERAGE}x`);
  }

  let cycle = 0;
  const shutdown = async () => {
    log('Shutting down...');
    if (position) {
      const es = position.side === 'buy' ? 'sell' : 'buy';
      await placeOrder(es, position.size, true);
      log(`Closed ${COIN} position`, 'EXIT');
    }
    const wr = tradeCount > 0 ? `${(winCount/tradeCount*100).toFixed(0)}%` : 'n/a';
    log(`=== Done === Trades:${tradeCount} WR:${wr} PnL:$${totalPnl.toFixed(2)}`);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  while (true) {
    try {
      cycle++;
      if (cycle % 30 === 1) balance = await getBalance();

      // Circuit breaker
      if (totalPnl <= -MAX_DAILY_LOSS) {
        log(`⛔ CIRCUIT BREAKER: $${totalPnl.toFixed(2)} loss. Stopping.`, 'WARN');
        if (position) await shutdown();
        break;
      }

      const currentPrice = await getMid();
      if (!currentPrice) { await sleep(5000); continue; }

      // Check exits first
      await checkExits(currentPrice);

      // Only look for new entries if no position and not in cooldown
      if (!position && Date.now() > cooldownUntil) {
        const candles = await getCandles();
        if (candles.length >= LOOKBACK_CANDLES) {
          const closes = candles.map(c => parseFloat(c.c));
          const rsiValues = computeRSI(closes);
          const currentRSI = rsiValues[rsiValues.length - 1];

          const divergences = detectDivergences(closes, rsiValues);

          // Only act on recent divergences (within last 3 candles)
          const recent = divergences.filter(d => d.index >= closes.length - 3 - PIVOT_LOOKBACK);

          if (recent.length > 0) {
            const div = recent[recent.length - 1]; // most recent
            const size = parseFloat((balance * POSITION_PCT * LEVERAGE / currentPrice).toFixed(SZ_DECIMALS));
            const notional = size * currentPrice;

            if (notional >= 10) {
              const direction = div.type === 'bullish' ? 'buy' : 'sell';

              log(`RSI DIVERGENCE: ${div.type.toUpperCase()} | price=${div.priceLevel.toFixed(2)} RSI=${div.rsiLevel.toFixed(1)} | ` +
                  `${div.type === 'bullish' ? `price↓${div.priceDrop}% RSI↑${div.rsiRise}` : `price↑${div.priceRise}% RSI↓${div.rsiDrop}`}`, 'DIV');

              const fillResult = await placeOrder(direction, size, false, 'limit');

              if (fillResult) {
                let entry;
                if (typeof fillResult === 'object' && fillResult.resting) {
                  entry = fillResult.price;
                  position = { side: direction, entry, size, time: Date.now(), oid: fillResult.oid, pending: true, highWater: 0 };
                } else {
                  entry = typeof fillResult === 'number' ? fillResult : currentPrice;
                  position = { side: direction, entry, size, time: Date.now(), highWater: 0 };
                }
                const fee = size * entry * MAKER_FEE_PCT;
                totalPnl -= fee;
                log(`OPENED ${direction.toUpperCase()} ${size} ${COIN} @ $${entry.toFixed(2)} ($${notional.toFixed(2)} notional) fee=$${fee.toFixed(4)}`, 'TRADE');
              }
            }
          }

          // Status line (every 6 cycles = ~1 min)
          if (cycle % 6 === 0) {
            const posStr = position ? `${position.side[0].toUpperCase()} @ $${position.entry.toFixed(0)}` : 'none';
            const wr = tradeCount > 0 ? `${(winCount/tradeCount*100).toFixed(0)}%` : 'n/a';
            log(`[c${cycle}] $${balance.toFixed(2)} | RSI=${currentRSI?.toFixed(1) || '?'} | pos=${posStr} | ${tradeCount}t ${wr} $${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}`);
          }
        }
      } else if (cycle % 6 === 0) {
        const posStr = position ? `${position.side[0].toUpperCase()} @ $${position.entry.toFixed(0)}` : 'cooling';
        const wr = tradeCount > 0 ? `${(winCount/tradeCount*100).toFixed(0)}%` : 'n/a';
        log(`[c${cycle}] $${balance.toFixed(2)} | pos=${posStr} | ${tradeCount}t ${wr} $${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}`);
      }

      await sleep(POLL_INTERVAL_MS);
    } catch (e) {
      log(`Error: ${e.message}`, 'WARN');
      await sleep(10000);
    }
  }
}

run().catch(e => { console.error(e); process.exit(1); });
