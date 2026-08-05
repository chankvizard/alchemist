# Vercel Python serverless function
# GET /api/fundamental?ticker=BBCA
# Requirements: yfinance

import json
import yfinance as yf
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs


def get_fundamental(ticker_base):
    t = ticker_base.upper().replace('.JK', '') + '.JK'
    stock = yf.Ticker(t)

    info = stock.info
    if not info or info.get('trailingPE') is None and info.get('marketCap') is None:
        # Try without .JK as fallback
        stock = yf.Ticker(ticker_base.upper())
        info = stock.info

    if not info:
        raise ValueError('No data returned — check the ticker')

    # Price history (5 years monthly for sparkline)
    hist = stock.history(period='5y', interval='1mo')
    price_history = hist['Close'].dropna().tolist()[-60:]

    # DER: yfinance gives debtToEquity as percentage (e.g. 45.2 means 0.452x)
    der_raw = info.get('debtToEquity')
    der = der_raw / 100 if der_raw is not None else None

    return {
        'ticker':       ticker_base.upper().replace('.JK', ''),
        'name':         info.get('shortName') or info.get('longName') or ticker_base,
        'price':        info.get('currentPrice') or info.get('previousClose'),
        'eps':          info.get('trailingEps'),
        'bvps':         info.get('bookValue'),
        'pbv':          info.get('priceToBook'),
        'per':          info.get('trailingPE'),
        'roe':          info.get('returnOnEquity'),
        'der':          der,
        'npm':          info.get('profitMargins'),
        'roa':          info.get('returnOnAssets'),
        'mcap':         info.get('marketCap'),
        'rev':          info.get('totalRevenue'),
        'curr':         info.get('currentRatio'),
        'divY':         info.get('dividendYield'),
        'high52':       info.get('fiftyTwoWeekHigh'),
        'low52':        info.get('fiftyTwoWeekLow'),
        'sector':       info.get('sector'),
        'industry':     info.get('industry'),
        'priceHistory': price_history,
    }


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        ticker = (params.get('ticker') or [''])[0].strip()

        if not ticker:
            self._respond(400, {'error': 'ticker parameter required'})
            return

        try:
            data = get_fundamental(ticker)
            self._respond(200, data)
        except Exception as e:
            self._respond(500, {'error': str(e)})

    def _respond(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', len(payload))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass  # suppress default logging
