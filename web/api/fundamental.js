// Vercel Node.js serverless function
// Uses yahoo-finance2 which handles Yahoo auth headers properly

import yahooFinance from 'yahoo-finance2'

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET')

  const ticker = (req.query.ticker || '').toUpperCase().replace('.JK', '')
  if (!ticker) return res.status(400).json({ error: 'ticker required' })

  const t = `${ticker}.JK`

  try {
    const [quote, summary] = await Promise.all([
      yahooFinance.quote(t),
      yahooFinance.quoteSummary(t, {
        modules: ['defaultKeyStatistics', 'financialData', 'summaryDetail', 'assetProfile']
      }),
    ])

    const ks  = summary.defaultKeyStatistics || {}
    const fd  = summary.financialData        || {}
    const sd  = summary.summaryDetail        || {}
    const ap  = summary.assetProfile         || {}

    // Historical prices for sparkline
    const hist = await yahooFinance.historical(t, {
      period1: new Date(Date.now() - 5 * 365 * 24 * 60 * 60 * 1000),
      interval: '1mo',
    })
    const priceHistory = hist.map(h => h.close).filter(Boolean).slice(-60)

    // DER: yahoo-finance2 gives debtToEquity as ratio already (unlike raw API)
    const der = ks.debtToEquity != null ? ks.debtToEquity / 100 : null

    return res.status(200).json({
      ticker,
      name:         quote.shortName || quote.longName || ticker,
      price:        quote.regularMarketPrice || sd.previousClose,
      eps:          ks.trailingEps,
      bvps:         ks.bookValue,
      pbv:          ks.priceToBook,
      per:          sd.trailingPE || ks.trailingPE,
      roe:          fd.returnOnEquity,
      der,
      npm:          fd.profitMargins,
      roa:          fd.returnOnAssets,
      mcap:         sd.marketCap,
      rev:          fd.totalRevenue,
      curr:         fd.currentRatio,
      divY:         sd.dividendYield,
      high52:       sd.fiftyTwoWeekHigh,
      low52:        sd.fiftyTwoWeekLow,
      sector:       ap.sector   || null,
      industry:     ap.industry || null,
      priceHistory,
    })
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to fetch data' })
  }
}
