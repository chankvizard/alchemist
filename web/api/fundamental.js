// Vercel serverless function — runs server-side, no CORS issues
// GET /api/fundamental?ticker=BBCA

export default async function handler(req, res) {
  // CORS headers so browser can call this
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET')

  const { ticker } = req.query
  if (!ticker) return res.status(400).json({ error: 'ticker required' })

  const t = ticker.toUpperCase().replace('.JK', '') + '.JK'

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
  }

  try {
    // Fetch both endpoints in parallel
    const [summaryRes, chartRes] = await Promise.all([
      fetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${t}?modules=defaultKeyStatistics,financialData,summaryDetail,assetProfile`, { headers }),
      fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${t}?range=5y&interval=1mo`, { headers }),
    ])

    if (!summaryRes.ok) throw new Error(`Yahoo returned ${summaryRes.status}`)

    const [summaryBody, chartBody] = await Promise.all([
      summaryRes.json(),
      chartRes.json(),
    ])

    if (summaryBody.quoteSummary?.error) {
      throw new Error(summaryBody.quoteSummary.error.description || 'Symbol not found')
    }

    const result  = summaryBody.quoteSummary?.result?.[0]
    if (!result) throw new Error('No data returned — check the ticker')

    const ks  = result.defaultKeyStatistics || {}
    const fd  = result.financialData        || {}
    const sd  = result.summaryDetail        || {}
    const ap  = result.assetProfile         || {}

    const chartResult  = chartBody?.chart?.result?.[0]
    const meta         = chartResult?.meta || {}
    const closes       = chartResult?.indicators?.quote?.[0]?.close || []
    const timestamps   = chartResult?.timestamp || []

    // Normalize DER — Yahoo gives it as percentage (e.g. 45.2 = 0.452x)
    const derRaw = ks.debtToEquity?.raw
    const der    = derRaw != null ? derRaw / 100 : null

    return res.status(200).json({
      ticker:    t.replace('.JK', ''),
      name:      meta.shortName || meta.longName || t,
      price:     meta.regularMarketPrice || sd.previousClose?.raw,
      eps:       ks.trailingEps?.raw,
      bvps:      ks.bookValue?.raw,
      pbv:       ks.priceToBook?.raw,
      per:       sd.trailingPE?.raw || ks.trailingPE?.raw,
      roe:       fd.returnOnEquity?.raw,
      der,
      npm:       fd.profitMargins?.raw,
      roa:       fd.returnOnAssets?.raw,
      mcap:      sd.marketCap?.raw,
      rev:       fd.totalRevenue?.raw,
      curr:      fd.currentRatio?.raw,
      divY:      sd.dividendYield?.raw,
      high52:    sd.fiftyTwoWeekHigh?.raw,
      low52:     sd.fiftyTwoWeekLow?.raw,
      sector:    ap.sector   || null,
      industry:  ap.industry || null,
      // Price history for sparkline (last 60 months)
      priceHistory: closes.filter(Boolean).slice(-60),
      timestamps:   timestamps.slice(-60),
    })

  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to fetch data' })
  }
}
