"""
Alchemist Pre-Market Scalp Scanner v3
======================================
Changes from v2:
  - Outputs results/latest.json instead of printing to console
  - Retry logic with exponential backoff on Yahoo Finance
  - OHLC.dev as fallback when Yahoo rate-limits (free tier)
  - Graceful batch delays to avoid rate limiting on GitHub Actions
  - Console progress still shown for local runs
  - history/{date}.json also saved for trend tracking

Data priority: Yahoo Finance → OHLC.dev → Local cache
Filter:        Price < Rp 1,500 | Min Profit: 3% | Min R:R: 1.5
Run:           python alchemist_scanner_v3.py
"""

import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta

# ─── PATHS ────────────────────────────────────────────────────
SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
RESULTS_DIR  = os.path.join(SCRIPT_DIR, "results")
HISTORY_DIR  = os.path.join(RESULTS_DIR, "history")
CACHE_FILE   = os.path.join(SCRIPT_DIR, "alchemist_cache.json")
TICKER_FILE  = os.path.join(os.path.expanduser("~"), "idx_stock_codes.txt")
OUTPUT_FILE  = os.path.join(RESULTS_DIR, "latest.json")

os.makedirs(RESULTS_DIR, exist_ok=True)
os.makedirs(HISTORY_DIR, exist_ok=True)

# ─── CONFIG ───────────────────────────────────────────────────
MAX_PRICE       = 1500
MIN_PROFIT_PCT  = 3.0
MIN_RR          = 1.5
RETRY_MAX       = 3          # attempts per Yahoo endpoint
RETRY_BACKOFF   = [1, 3, 7]  # seconds between retries
BATCH_SIZE      = 30         # pause every N tickers
BATCH_DELAY     = 1.5        # seconds per batch pause

# ─── URL TEMPLATES ────────────────────────────────────────────
YF_ENDPOINTS = [
    "https://query1.finance.yahoo.com/v8/finance/chart/{}?range=1mo&interval=1d",
    "https://query2.finance.yahoo.com/v8/finance/chart/{}?range=1mo&interval=1d",
]
# OHLC.dev — free tier, IDX-focused
# Returns OHLCV array for a ticker (no .JK suffix needed)
OHLCDEV_URL = "https://api.ohlc.dev/v1/idx/ohlcv?ticker={}&period=1mo&interval=1d"

# ─── UNIVERSE ─────────────────────────────────────────────────
def load_universe():
    if os.path.exists(TICKER_FILE):
        codes = []
        with open(TICKER_FILE, "r", encoding="utf-8-sig") as f:
            for line in f:
                code = line.strip()
                if code and not code.startswith("#"):
                    codes.append(code + ".JK")
        if codes:
            return codes
    # Fallback: actively traded IDX stocks
    return [
        "BBCA.JK","BBRI.JK","BMRI.JK","BBNI.JK","BRIS.JK","BNGA.JK","BBTN.JK",
        "BTPS.JK","ARTO.JK","BFIN.JK","ADMF.JK","TLKM.JK","ISAT.JK","EXCL.JK",
        "MTEL.JK","TOWR.JK","GOTO.JK","BUKA.JK","ANTM.JK","ADRO.JK","PTBA.JK",
        "INCO.JK","TINS.JK","MDKA.JK","BRMS.JK","PSAB.JK","ITMG.JK","HRUM.JK",
        "MEDC.JK","PGAS.JK","UNVR.JK","ICBP.JK","INDF.JK","MYOR.JK","CPIN.JK",
        "AMRT.JK","MAPA.JK","ACES.JK","KLBF.JK","HMSP.JK","GGRM.JK","ULTJ.JK",
        "JPFA.JK","UNTR.JK","PTPP.JK","WIKA.JK","ADHI.JK","JSMR.JK","TBIG.JK",
        "BSDE.JK","ASRI.JK","CTRA.JK","SMRA.JK","PWON.JK","PANI.JK","DEWA.JK",
        "BULL.JK","DMAS.JK","ZINC.JK","SMRU.JK","ARCI.JK","ENRG.JK","AKRA.JK",
    ]

UNIVERSE = load_universe()


# ═══════════════════════════════════════════════════════════════
#  DATA LAYER
# ═══════════════════════════════════════════════════════════════

def load_cache():
    if not os.path.exists(CACHE_FILE):
        return {}
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

def save_cache(cache):
    try:
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False)
    except Exception:
        pass


def _http_get(url, timeout=15):
    """Raw HTTP GET with standard browser headers. Returns bytes or raises."""
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept": "application/json,text/html,*/*",
        "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8",
    }
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _parse_yahoo_response(raw_bytes, ticker):
    """Parse raw Yahoo Finance v8 chart JSON into standard data dict."""
    data = json.loads(raw_bytes)
    if data.get("chart", {}).get("error"):
        return None
    result = data["chart"]["result"]
    if not result:
        return None
    result = result[0]
    meta  = result["meta"]
    quote = result["indicators"]["quote"][0]
    closes = quote.get("close", [])
    valid_closes = [x for x in closes if x is not None]
    if len(valid_closes) < 5:
        return None
    return {
        "ticker":     ticker,
        "name":       meta.get("shortName") or meta.get("longName") or ticker,
        "currency":   meta.get("currency", "IDR"),
        "last_price": meta.get("regularMarketPrice"),
        "prev_close": meta.get("chartPreviousClose"),
        "high_52w":   meta.get("fiftyTwoWeekHigh"),
        "low_52w":    meta.get("fiftyTwoWeekLow"),
        "timestamps": result.get("timestamp", []),
        "open":       quote.get("open", []),
        "high":       quote.get("high", []),
        "low":        quote.get("low", []),
        "close":      closes,
        "volume":     quote.get("volume", []),
        "source":     "yahoo",
    }


def fetch_yahoo(ticker):
    """
    Try both Yahoo Finance endpoints with retry + exponential backoff.
    Returns data dict or None.
    """
    for endpoint in YF_ENDPOINTS:
        url = endpoint.format(ticker)
        for attempt in range(RETRY_MAX):
            try:
                raw = _http_get(url)
                parsed = _parse_yahoo_response(raw, ticker)
                if parsed:
                    return parsed
            except urllib.error.HTTPError as e:
                if e.code in (429, 503):
                    # Rate limited — backoff then retry
                    wait = RETRY_BACKOFF[min(attempt, len(RETRY_BACKOFF) - 1)]
                    time.sleep(wait)
                    continue
                # 404 or other permanent error → skip this endpoint
                break
            except Exception:
                wait = RETRY_BACKOFF[min(attempt, len(RETRY_BACKOFF) - 1)]
                time.sleep(wait)
    return None


def fetch_ohlcdev(ticker):
    """
    OHLC.dev fallback — IDX-focused, free tier.
    Ticker format: strip .JK suffix (e.g. BRMS.JK → BRMS)
    Returns data dict or None.
    """
    ticker_base = ticker.replace(".JK", "")
    url = OHLCDEV_URL.format(ticker_base)
    try:
        raw  = _http_get(url, timeout=10)
        data = json.loads(raw)

        # OHLC.dev response: { ticker, data: [{date, open, high, low, close, volume}, ...] }
        rows = data.get("data") or data.get("ohlcv") or []
        if not rows or len(rows) < 5:
            return None

        # Normalize to same format as Yahoo
        opens, highs, lows, closes, volumes, timestamps = [], [], [], [], [], []
        for row in rows:
            opens.append(row.get("open"))
            highs.append(row.get("high"))
            lows.append(row.get("low"))
            closes.append(row.get("close"))
            volumes.append(row.get("volume", 0))
            timestamps.append(row.get("date", ""))

        last_close = closes[-1] if closes else None
        if last_close is None:
            return None

        return {
            "ticker":     ticker,
            "name":       data.get("name") or ticker_base,
            "currency":   "IDR",
            "last_price": last_close,
            "prev_close": closes[-2] if len(closes) >= 2 else None,
            "high_52w":   max(h for h in highs if h) if highs else None,
            "low_52w":    min(l for l in lows  if l) if lows  else None,
            "timestamps": timestamps,
            "open":       opens,
            "high":       highs,
            "low":        lows,
            "close":      closes,
            "volume":     volumes,
            "source":     "ohlcdev",
        }
    except Exception:
        return None


def fetch_data(ticker):
    """
    Full data fetch pipeline:
      1. Yahoo Finance (with retry)
      2. OHLC.dev (free fallback)
      3. Local cache (stale but better than nothing)
    Updates cache on successful fetch.
    """
    cache     = load_cache()
    today_str = datetime.now().strftime("%Y-%m-%d")

    # ── 1. Yahoo Finance ──
    data = fetch_yahoo(ticker)
    if data:
        cache[ticker] = {
            "timestamp":  today_str,
            "name":       data["name"],
            "last_price": data["last_price"],
            "prev_close": data["prev_close"],
            "high_52w":   data.get("high_52w"),
            "low_52w":    data.get("low_52w"),
            "currency":   data["currency"],
            "open":       data["open"],
            "high":       data["high"],
            "low":        data["low"],
            "close":      data["close"],
            "volume":     data["volume"],
            "timestamps": data["timestamps"],
        }
        save_cache(cache)
        return data

    # ── 2. OHLC.dev fallback ──
    data = fetch_ohlcdev(ticker)
    if data:
        cache[ticker] = {
            "timestamp":  today_str,
            "name":       data["name"],
            "last_price": data["last_price"],
            "prev_close": data["prev_close"],
            "high_52w":   data.get("high_52w"),
            "low_52w":    data.get("low_52w"),
            "currency":   data["currency"],
            "open":       data["open"],
            "high":       data["high"],
            "low":        data["low"],
            "close":      data["close"],
            "volume":     data["volume"],
            "timestamps": data["timestamps"],
        }
        save_cache(cache)
        return data

    # ── 3. Local cache (stale) ──
    if ticker in cache:
        cached = cache[ticker]
        cached_date = cached.get("timestamp", "")
        stale_days = 0
        try:
            delta = datetime.now() - datetime.strptime(cached_date, "%Y-%m-%d")
            stale_days = delta.days
        except Exception:
            pass

        return {
            "ticker":     ticker,
            "name":       cached.get("name", ticker),
            "currency":   cached.get("currency", "IDR"),
            "last_price": cached.get("last_price"),
            "prev_close": cached.get("prev_close"),
            "high_52w":   cached.get("high_52w"),
            "low_52w":    cached.get("low_52w"),
            "timestamps": cached.get("timestamps", []),
            "open":       cached.get("open", []),
            "high":       cached.get("high", []),
            "low":        cached.get("low", []),
            "close":      cached.get("close", []),
            "volume":     cached.get("volume", []),
            "source":     "cache",
            "stale_days": stale_days,
        }

    return None


# ═══════════════════════════════════════════════════════════════
#  ALGORITHM  (unchanged from v2 — your Alchemist logic)
# ═══════════════════════════════════════════════════════════════

def find_swing_points(highs, lows, lookback=2):
    n = len(highs)
    swing_highs, swing_lows = [], []
    for i in range(lookback, n - lookback):
        wh = highs[i-lookback:i] + highs[i+1:i+lookback+1]
        wl = lows[i-lookback:i]  + lows[i+1:i+lookback+1]
        if highs[i] is not None and all(h is not None and highs[i] > h for h in wh):
            swing_highs.append((i, highs[i]))
        if lows[i] is not None and all(l is not None and lows[i] < l for l in wl):
            swing_lows.append((i, lows[i]))
    return swing_highs, swing_lows


def detect_sweeps(highs, lows, closes, swing_highs, swing_lows):
    n = len(closes)
    buy_sweeps, sell_sweeps = [], []
    recent_start = max(0, n - 5)

    for idx, sh_val in swing_highs:
        for i in range(idx + 1, n):
            if highs[i] is None or closes[i] is None:
                continue
            if highs[i] > sh_val and closes[i] < sh_val:
                buy_sweeps.append({"bar": i, "swept_at": sh_val,
                                   "sweep_high": highs[i], "close": closes[i]})
                break

    for idx, sl_val in swing_lows:
        for i in range(idx + 1, n):
            if lows[i] is None or closes[i] is None:
                continue
            if lows[i] < sl_val and closes[i] > sl_val:
                sell_sweeps.append({"bar": i, "swept_at": sl_val,
                                    "sweep_low": lows[i], "close": closes[i]})
                break

    recent_buy  = [s for s in buy_sweeps  if s["bar"] >= recent_start]
    recent_sell = [s for s in sell_sweeps if s["bar"] >= recent_start]
    all_recent  = recent_buy + recent_sell

    return {
        "buy_sweeps":       buy_sweeps,
        "sell_sweeps":      sell_sweeps,
        "recent_buy":       recent_buy,
        "recent_sell":      recent_sell,
        "has_recent_sweep": len(all_recent) > 0,
        "latest":           max(all_recent, key=lambda x: x["bar"]) if all_recent else None,
    }


def detect_base_forming(closes, highs, lows, volumes):
    if len(closes) < 7:
        return False, []
    last_5c = closes[-5:]
    last_5h = highs[-5:]
    last_5l = lows[-5:]
    last_5v = volumes[-5:]

    if any(x is None for x in last_5c):
        return False, []
    if any(h is None or l is None for h, l in zip(last_5h, last_5l)):
        return False, []

    avg_price = sum(last_5c) / 5
    if avg_price <= 0:
        return False, []

    avg_range_pct = sum((h - l) / avg_price for h, l in zip(last_5h, last_5l)) / 5

    valid_vols = [v for v in last_5v if v is not None and v > 0]
    vol_declining = False
    if len(valid_vols) >= 4:
        if sum(valid_vols[:2]) > 0 and sum(valid_vols[-3:]) < sum(valid_vols[:2]) * 0.70:
            vol_declining = True

    range_tight = avg_range_pct < 0.05
    signals = []
    if range_tight:    signals.append("TIGHT_RANGE")
    if vol_declining:  signals.append("VOL_DECLINING")
    return (range_tight and vol_declining), signals


def get_dealing_range(swing_highs, swing_lows):
    if not swing_lows or not swing_highs:
        return None
    recent_low  = sorted(swing_lows,  key=lambda x: x[0])[-1]
    candidates  = [sh for sh in swing_highs if sh[0] > recent_low[0]] or swing_highs
    recent_high = sorted(candidates, key=lambda x: x[0])[-1]
    if recent_low[1] >= recent_high[1]:
        return None
    eq = (recent_low[1] + recent_high[1]) / 2
    return {"low": recent_low[1], "low_bar": recent_low[0],
            "high": recent_high[1], "high_bar": recent_high[0],
            "equilibrium": eq}


def detect_discount_premium(price, dealing_range):
    if dealing_range is None or price is None:
        return None
    eq = dealing_range["equilibrium"]
    if eq <= 0:
        return None
    if price < eq * 0.95:   return "DEEP_DISCOUNT"
    if price < eq:          return "DISCOUNT"
    if price > eq * 1.05:   return "DEEP_PREMIUM"
    if price > eq:          return "PREMIUM"
    return "EQUILIBRIUM"


def analyze_volume(volumes):
    empty = {"vol_spike": False, "vol_exhaust": False, "vol_ok": False,
             "avg_10": 0, "last_vol": 0, "multiplier": 0}
    if len(volumes) < 10:
        return empty
    valid = [v for v in volumes[-10:] if v is not None and v > 0]
    if len(valid) < 5:
        return empty
    avg_10   = sum(valid) / len(valid)
    last_vol = volumes[-1] or 0
    mult     = round(last_vol / avg_10, 1) if avg_10 > 0 else 0
    return {
        "vol_spike":   last_vol > avg_10 * 3.0,
        "vol_exhaust": last_vol > 0 and avg_10 > 0 and last_vol < avg_10 * 0.5,
        "vol_ok":      avg_10 > 500_000,
        "avg_10":      avg_10,
        "last_vol":    last_vol,
        "multiplier":  mult,
    }


def detect_confirmation_candle(opens, highs, lows, closes):
    n = len(closes)
    if n < 3:
        return False, []
    o, h, l, c = opens[-1], highs[-1], lows[-1], closes[-1]
    prev_c = closes[-2]
    prev_l = lows[-2]
    if any(x is None for x in [o, h, l, c, prev_c, prev_l]):
        return False, []
    body        = abs(c - o)
    lower_wick  = min(c, o) - l
    upper_wick  = h - max(c, o)
    total_range = h - l
    signals = []
    if total_range > 0:
        if c > o and lower_wick > body * 1.5 and upper_wick < body * 0.5:
            signals.append("HAMMER")
        if c < o and upper_wick > body * 1.5 and lower_wick < body * 0.5:
            signals.append("SHOOTING_STAR")
    if c > prev_c and l <= prev_l:
        signals.append("HIGHER_CLOSE_SWEEP_WICK")
    if c > o and o <= prev_c and c > prev_c:
        signals.append("BULLISH_ENGULFING_POTENTIAL")
    return len(signals) > 0, signals


def detect_short_term_structure(closes, swing_highs, swing_lows):
    if len(closes) < 5:
        return "INSUFFICIENT", [], False, False
    signals = []
    sorted_lows = sorted(swing_lows, key=lambda x: x[0])
    if len(sorted_lows) >= 2:
        if sorted_lows[-1][1] > sorted_lows[-2][1]:  signals.append("HIGHER_LOW")
        elif sorted_lows[-1][1] < sorted_lows[-2][1]: signals.append("LOWER_LOW")

    in_downtrend = False
    if closes[-1] and closes[-6] and closes[-11]:
        if closes[-1] < closes[-6] < closes[-11]:
            in_downtrend = True
            signals.append("DOWNTREND")

    in_freefall = False
    if closes[-1] and closes[-4]:
        if closes[-1] < closes[-4] * 0.92:
            in_freefall = True
            signals.append("FREEFALL")

    return "OK", signals, in_downtrend, in_freefall


def calc_entry_sl_tp(price, swing_highs, swing_lows, dealing_range, has_sweep):
    if not price or price <= 0:
        return None
    entry = price
    valid_sl = sorted([s for s in swing_lows if s[1] < price], key=lambda x: x[0])
    structural_sl = valid_sl[-1][1] * 0.99 if valid_sl else price * 0.95
    stop_loss = max(structural_sl, price * 0.96)

    if dealing_range and dealing_range["equilibrium"] > price:
        tp1 = dealing_range["equilibrium"]
    else:
        tp1 = price * 1.03

    valid_sh = sorted([s for s in swing_highs if s[1] > price], key=lambda x: x[0])
    tp2 = valid_sh[-1][1] if valid_sh else tp1 * 1.02
    if tp2 <= tp1:
        tp2 = tp1 * 1.02

    risk      = entry - stop_loss
    reward    = tp1 - entry
    if risk <= 0 or reward <= 0:
        return None

    return {
        "entry":      round(entry, 2),
        "stop_loss":  round(stop_loss, 2),
        "tp1":        round(tp1, 2),
        "tp2":        round(tp2, 2),
        "risk_pct":   round(risk / entry * 100, 1),
        "profit_pct": round((tp1 / entry - 1) * 100, 1),
        "rr":         round(reward / risk, 2),
    }


def calc_probability(signal_count, is_downtrend, is_freefall):
    if is_freefall or signal_count < 2:
        return 0, "SKIP"
    eff = signal_count - 1 if is_downtrend else signal_count
    if eff < 2:   return 0,  "SKIP"
    if eff == 2:  return 30, "LOW"
    if eff == 3:  return 50, "MEDIUM"
    if eff == 4:  return 70, "HIGH"
    return 85, "VERY_HIGH"


# ═══════════════════════════════════════════════════════════════
#  MAIN ANALYSIS PIPELINE
# ═══════════════════════════════════════════════════════════════

def analyze_alchemist(data):
    o = data["open"];  h = data["high"]
    l = data["low"];   c = data["close"]
    v = data["volume"]

    valid = [(o[i], h[i], l[i], c[i], v[i] if v[i] is not None else 0)
             for i in range(len(c))
             if c[i] is not None and h[i] is not None and l[i] is not None]
    if len(valid) < 10:
        return None

    bars    = valid[-20:]
    closes  = [b[3] for b in bars]
    highs   = [b[1] for b in bars]
    lows    = [b[2] for b in bars]
    volumes = [b[4] for b in bars]
    opens   = [b[0] for b in bars]
    last    = closes[-1]

    if last is None or last > MAX_PRICE:
        return None

    signal_count  = 0
    signal_labels = []

    # 1. Swing points
    swing_highs, swing_lows = find_swing_points(highs, lows)

    # 2. Sweep
    sweep_info = detect_sweeps(highs, lows, closes, swing_highs, swing_lows)
    if sweep_info["has_recent_sweep"]:
        signal_count += 1
        latest = sweep_info["latest"]
        if latest:
            signal_labels.append("SWEEP_SELL" if "sweep_low" in latest else "SWEEP_BUY")
    else:
        if swing_lows:
            recent_sl = min(sl[1] for sl in swing_lows[-2:])
            if recent_sl * 0.97 < last < recent_sl * 1.03:
                signal_labels.append("NEAR_LOW_ZONE")

    # 3. Base forming
    base_forming, base_sigs = detect_base_forming(closes, highs, lows, volumes)
    if base_forming:
        signal_count += 1
        signal_labels.append("BASE_FORMING")
    else:
        if "TIGHT_RANGE"    in base_sigs: signal_labels.append("TIGHT_RANGE")
        if "VOL_DECLINING"  in base_sigs: signal_labels.append("VOL_DECLINING")

    # 4. Dealing range / discount
    dealing_range = get_dealing_range(swing_highs, swing_lows)
    discount      = detect_discount_premium(last, dealing_range)
    if discount == "DEEP_DISCOUNT":
        signal_count += 2
        signal_labels.append("DEEP_DISCOUNT")
    elif discount == "DISCOUNT":
        signal_count += 1
        signal_labels.append("DISCOUNT")
    elif discount in ("DEEP_PREMIUM", "PREMIUM"):
        signal_labels.append("PREMIUM")

    # 5. Volume
    vol = analyze_volume(volumes)
    if vol["vol_spike"]:
        signal_count += 1
        signal_labels.append("VOL_SPIKE_{}x".format(vol["multiplier"]))
    if vol["vol_exhaust"]:
        signal_count += 1
        signal_labels.append("VOL_EXHAUST")
    if not vol["vol_ok"]:
        signal_count -= 1
        signal_labels.append("LOW_LIQ")

    # 6. Confirmation candle
    conf, conf_sigs = detect_confirmation_candle(opens, highs, lows, closes)
    if conf:
        signal_count += 1
        signal_labels.extend(conf_sigs)

    # 7. Short-term structure
    _, _, in_downtrend, in_freefall = detect_short_term_structure(closes, swing_highs, swing_lows)
    if in_freefall:
        signal_labels.append("FREEFALL")
    if in_downtrend and not sweep_info["has_recent_sweep"]:
        signal_labels.append("DOWNTREND_NOSWEEP")

    # 8. Entry / SL / TP
    trade = calc_entry_sl_tp(last, swing_highs, swing_lows, dealing_range,
                             sweep_info["has_recent_sweep"])
    if trade is None:
        return None
    if trade["profit_pct"] < MIN_PROFIT_PCT or trade["rr"] < MIN_RR:
        return None

    # 9. Probability
    prob, confidence = calc_probability(signal_count, in_downtrend, in_freefall)
    if prob == 0:
        return None

    return {
        "ticker":       data["ticker"],
        "name":         data["name"],
        "last":         last,
        "prob":         prob,
        "confidence":   confidence,
        "signalCount":  signal_count,
        "signals":      signal_labels,
        "entry":        trade["entry"],
        "stopLoss":     trade["stop_loss"],
        "tp1":          trade["tp1"],
        "tp2":          trade["tp2"],
        "profitPct":    trade["profit_pct"],
        "rr":           trade["rr"],
        "riskPct":      trade["risk_pct"],
        "hasSweep":     sweep_info["has_recent_sweep"],
        "baseForming":  base_forming,
        "volOk":        vol["vol_ok"],
        "avgVol":       round(vol["avg_10"]),
        "source":       data.get("source", "yahoo"),
        "stale":        data.get("stale_days", 0),
    }


# ═══════════════════════════════════════════════════════════════
#  OUTPUT — writes results/latest.json
# ═══════════════════════════════════════════════════════════════

def write_output(candidates, meta):
    today = datetime.now().strftime("%Y-%m-%d")

    payload = {
        "generatedAt":   datetime.now(timezone(timedelta(hours=7))).isoformat(),
        "scanDate":      today,
        "universeSize":  meta["total"],
        "scanned":       meta["scanned"],
        "errors":        meta["errors"],
        "priceFiltered": meta["price_filtered"],
        "elapsedSec":    meta["elapsed_sec"],
        "sources":       meta["sources"],
        "candidates":    candidates,
        "summary": {
            "total":    len(candidates),
            "high":     len([c for c in candidates if c["prob"] >= 70]),
            "medium":   len([c for c in candidates if 50 <= c["prob"] < 70]),
            "watchlist":len([c for c in candidates if c["prob"] == 30]),
        }
    }

    # Write latest.json
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    # Also archive to history/
    history_file = os.path.join(HISTORY_DIR, "{}.json".format(today))
    with open(history_file, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    return OUTPUT_FILE


# ═══════════════════════════════════════════════════════════════
#  MAIN
# ═══════════════════════════════════════════════════════════════

def main():
    # Allow stdout to handle unicode on Windows
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    print("=" * 78)
    print("  ALCHEMIST PRE-MARKET SCALP SCANNER v3")
    print("  Universe: {} stocks | Yahoo → OHLC.dev → Cache".format(len(UNIVERSE)))
    print("  Filter: Price < Rp {:,} | Min Profit: {}% | Min R:R: {}".format(
        MAX_PRICE, MIN_PROFIT_PCT, MIN_RR))
    print("  Date: {}".format(datetime.now().strftime("%Y-%m-%d %H:%M WIB")))
    print("=" * 78)

    results      = []
    errors       = 0
    price_skip   = 0
    no_data      = 0
    sources      = {"yahoo": 0, "ohlcdev": 0, "cache": 0}
    start        = time.time()

    for i, ticker in enumerate(UNIVERSE):
        elapsed = time.time() - start
        eta_str = ""
        if i > 0:
            remaining = (elapsed / i) * (len(UNIVERSE) - i)
            eta_str = " | ETA ~{}m{}s".format(int(remaining // 60), int(remaining % 60))

        sys.stdout.write("\r  [{}/{}] {:<12}  {:.0f}s{}   ".format(
            i + 1, len(UNIVERSE), ticker, elapsed, eta_str))
        sys.stdout.flush()

        data = fetch_data(ticker)

        if data is None:
            errors += 1
            continue

        src = data.get("source", "yahoo")
        if "ohlcdev" in src:  sources["ohlcdev"] += 1
        elif "cache"  in src: sources["cache"]   += 1
        else:                 sources["yahoo"]    += 1

        if data.get("last_price") and data["last_price"] > MAX_PRICE:
            price_skip += 1
            continue

        analysis = analyze_alchemist(data)
        if analysis:
            results.append(analysis)

        # Batch pause — friendlier to rate limits
        if (i + 1) % BATCH_SIZE == 0:
            time.sleep(BATCH_DELAY)

    elapsed_total = round(time.time() - start, 1)
    print("\n")

    results.sort(key=lambda x: x["prob"], reverse=True)

    meta = {
        "total":          len(UNIVERSE),
        "scanned":        len(UNIVERSE) - errors,
        "errors":         errors,
        "price_filtered": price_skip,
        "elapsed_sec":    elapsed_total,
        "sources":        sources,
    }

    output_path = write_output(results, meta)

    # ── Console summary (for local runs) ──
    print("=" * 78)
    print("  SCAN COMPLETE — {} candidates from {} stocks in {}s".format(
        len(results), len(UNIVERSE), elapsed_total))
    print("  Sources: Yahoo={} | OHLC.dev={} | Cache={}".format(
        sources["yahoo"], sources["ohlcdev"], sources["cache"]))
    print("  Errors: {} | Price-filtered: {}".format(errors, price_skip))
    print()

    high   = [r for r in results if r["prob"] >= 70]
    medium = [r for r in results if 50 <= r["prob"] < 70]
    watch  = [r for r in results if r["prob"] == 30]

    print("  HIGH ({})  |  MEDIUM ({})  |  WATCHLIST ({})".format(
        len(high), len(medium), len(watch)))
    print("=" * 78)

    if high:
        print("\n  TOP HIGH-PROBABILITY SETUPS:\n")
        for rank, r in enumerate(high[:5], 1):
            print("  #{} {} — {} | Rp {:,.0f} | Prob: {}% ({}) | R:R: {} | {}".format(
                rank, r["ticker"], r["name"][:22], r["last"],
                r["prob"], r["confidence"], r["rr"],
                " | ".join(r["signals"][:3])))
    elif medium:
        print("\n  No HIGH setups today. Top MEDIUM:\n")
        for r in medium[:3]:
            print("  {} — {} | Rp {:,.0f} | Prob: {}% | R:R: {} | {}".format(
                r["ticker"], r["name"][:22], r["last"],
                r["prob"], r["rr"], " | ".join(r["signals"][:2])))
    else:
        print("\n  No strong setups found. Check pre-session conditions.")

    print()
    print("  Output saved → {}".format(output_path))
    print()
    print("  DISCLAIMER: Algorithmic signals only. Not financial advice.")
    print("=" * 78)


if __name__ == "__main__":
    main()
