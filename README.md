# HL Scalper

Hyperliquid 5-minute momentum scalper for BTC, ETH, and HYPE perpetuals.

## Strategy
- Momentum + RSI + volume indicators on 5-min candles
- Cross-coin confirmation (2-6% edge boost when multiple coins agree)
- Low volatility regime filter
- 5x leverage, 1.5% stop loss, 2.5% take profit (1.67 R:R)

## Usage

```bash
# Install dependencies
npm install hyperliquid

# Dry run
HYPERLIQUID_PRIVATE_KEY=0x... node hl_scalper.mjs

# Live trading
HYPERLIQUID_PRIVATE_KEY=0x... node hl_scalper.mjs --live
```

## Config (edit top of hl_scalper.mjs)
| Param | Default | Description |
|-------|---------|-------------|
| COINS | BTC, ETH, HYPE | Assets to trade |
| LEVERAGE | 5 | Cross margin leverage |
| MAX_POSITIONS | 2 | Max simultaneous positions |
| MAX_POSITION_PCT | 30% | Max % of equity per position |
| STOP_LOSS_PCT | 1.5% | Stop loss threshold |
| TAKE_PROFIT_PCT | 2.5% | Take profit threshold |
| POLL_INTERVAL_MS | 30000 | Scan interval (ms) |
| MIN_CONFIDENCE | 50% | Minimum signal confidence to enter |

## Requirements
- Node.js 18+
- Hyperliquid API wallet key (generate at https://app.hyperliquid.xyz/API)

## ⚠️ Disclaimer
This is experimental trading software. Use at your own risk. Start with dry run mode.
