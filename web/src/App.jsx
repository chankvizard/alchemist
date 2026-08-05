import { useState, useEffect, useMemo } from 'react'

// ─── CONFIG ───────────────────────────────────────────────────
const DATA_URL = import.meta.env.VITE_DATA_URL || '/results/latest.json'

// Vercel serverless function handles Yahoo Finance fetch server-side (no CORS)
const FUNDAMENTAL_API = (ticker) => `/api/fundamental?ticker=${ticker.toUpperCase().replace('.JK','')}`

// ─── HELPERS ──────────────────────────────────────────────────
const fmt    = (n) => n == null ? '—' : `Rp ${Number(n).toLocaleString('id-ID')}`
const fmtB   = (n) => n == null ? '—' : n >= 1e12 ? `${(n/1e12).toFixed(2)}T` : n >= 1e9 ? `${(n/1e9).toFixed(1)}B` : n >= 1e6 ? `${(n/1e6).toFixed(1)}M` : String(n)
const fmtPct = (n) => n == null ? '—' : `${(n * 100).toFixed(1)}%`
const fmtX   = (n) => n == null ? '—' : `${Number(n).toFixed(2)}x`
const fmtN   = (n, dec=2) => n == null ? '—' : Number(n).toFixed(dec)
const fmtVol = (n) => { if (!n) return '—'; if (n >= 1e6) return `${(n/1e6).toFixed(1)}M`; if (n >= 1e3) return `${(n/1e3).toFixed(0)}K`; return String(n) }
const fmtTime = (iso) => {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' WIB' }
  catch { return iso }
}
const probColor = (p) => p >= 70 ? 'var(--green)' : p >= 50 ? 'var(--amber)' : 'var(--muted)'
const confidenceBadge = (conf) => ({ VERY_HIGH: { label: 'VERY HIGH', color: '#27AE60' }, HIGH: { label: 'HIGH', color: 'var(--green)' }, MEDIUM: { label: 'MED', color: 'var(--amber)' }, LOW: { label: 'LOW', color: 'var(--muted)' } }[conf] || { label: conf || '—', color: 'var(--muted)' })
const signalColor = (sig) => {
  if (sig.startsWith('SWEEP'))   return '#9B59B6'
  if (sig.includes('DISCOUNT'))  return 'var(--green)'
  if (sig.includes('VOL_SPIKE')) return 'var(--blue)'
  if (sig.includes('BASE') || sig.includes('TIGHT')) return 'var(--amber)'
  if (sig.includes('FREEFALL') || sig.includes('LOW_LIQ')) return 'var(--red)'
  if (sig.includes('HAMMER') || sig.includes('ENGULF') || sig.includes('HIGHER_CLOSE')) return '#1ABC9C'
  return 'var(--muted)'
}

// ─── VALUATION FORMULAS ───────────────────────────────────────
function calcGrahamNumber(eps, bvps) {
  if (!eps || !bvps || eps <= 0 || bvps <= 0) return null
  return Math.sqrt(22.5 * eps * bvps)
}

function calcLKHChecklist(d) {
  const checks = [
    { label: 'PBV < 1',    pass: d.pbv != null && d.pbv < 1,    value: d.pbv != null ? fmtX(d.pbv) : '—',    tip: 'Price below book value — classic undervaluation signal (Lo Kheng Hong)' },
    { label: 'PER < 10',   pass: d.per != null && d.per < 10,   value: d.per != null ? fmtX(d.per) : '—',    tip: 'Price-to-earnings below 10 — cheap relative to earnings' },
    { label: 'ROE > 15%',  pass: d.roe != null && d.roe > 0.15, value: d.roe != null ? fmtPct(d.roe) : '—',  tip: 'Return on equity above 15% — management creating value' },
    { label: 'DER < 1',    pass: d.der != null && d.der < 1,    value: d.der != null ? fmtX(d.der) : '—',    tip: 'Debt-to-equity below 1 — low leverage, safer balance sheet' },
    { label: 'NPM > 10%',  pass: d.npm != null && d.npm > 0.10, value: d.npm != null ? fmtPct(d.npm) : '—',  tip: 'Net profit margin above 10% — healthy earnings quality' },
  ]
  const passed = checks.filter(c => c.pass).length
  return { checks, passed, total: checks.length }
}

function calcDCF(eps, growthRate, discountRate, years = 10) {
  if (!eps || eps <= 0) return null
  let pv = 0
  for (let i = 1; i <= years; i++) {
    const futurEps = eps * Math.pow(1 + growthRate, i)
    pv += futurEps / Math.pow(1 + discountRate, i)
  }
  // Terminal value (Gordon Growth Model, terminal growth = 3%)
  const terminalEps  = eps * Math.pow(1 + growthRate, years)
  const terminalValue = terminalEps * (1 + 0.03) / (discountRate - 0.03)
  const terminalPV   = terminalValue / Math.pow(1 + discountRate, years)
  return pv + terminalPV
}

function getVerdict(price, grahamNum, dcfValue, lkh) {
  const signals = []
  let bullish = 0, bearish = 0

  if (grahamNum) {
    const margin = (grahamNum - price) / grahamNum
    if (margin > 0.3)       { signals.push({ text: `Graham: ${Math.round(margin*100)}% below intrinsic`, type: 'bull' }); bullish += 2 }
    else if (margin > 0)    { signals.push({ text: `Graham: slight discount`, type: 'bull' }); bullish += 1 }
    else if (margin > -0.2) { signals.push({ text: `Graham: slight premium`, type: 'bear' }); bearish += 1 }
    else                    { signals.push({ text: `Graham: ${Math.round(-margin*100)}% above intrinsic`, type: 'bear' }); bearish += 2 }
  }

  if (dcfValue) {
    const margin = (dcfValue - price) / dcfValue
    if (margin > 0.3)       { signals.push({ text: `DCF: ${Math.round(margin*100)}% upside`, type: 'bull' }); bullish += 2 }
    else if (margin > 0)    { signals.push({ text: `DCF: moderate upside`, type: 'bull' }); bullish += 1 }
    else                    { signals.push({ text: `DCF: overvalued vs cash flows`, type: 'bear' }); bearish += 2 }
  }

  if (lkh.passed >= 4)      { signals.push({ text: `LKH: ${lkh.passed}/5 criteria passed`, type: 'bull' }); bullish += 2 }
  else if (lkh.passed >= 3) { signals.push({ text: `LKH: ${lkh.passed}/5 criteria passed`, type: 'neutral' }); bullish += 1 }
  else                      { signals.push({ text: `LKH: only ${lkh.passed}/5 criteria`, type: 'bear' }); bearish += 1 }

  const score = bullish - bearish
  let verdict, color
  if (score >= 4)      { verdict = 'UNDERVALUED';    color = 'var(--green)' }
  else if (score >= 2) { verdict = 'FAIRLY VALUED';  color = 'var(--amber)' }
  else if (score >= 0) { verdict = 'WATCH';          color = 'var(--amber)' }
  else                 { verdict = 'OVERVALUED';     color = 'var(--red)'   }

  return { verdict, color, signals, score }
}

// ─── SAMPLE SCANNER DATA ──────────────────────────────────────
const SAMPLE = {
  generatedAt: new Date().toISOString(), scanDate: new Date().toISOString().slice(0,10),
  universeSize: 912, scanned: 905, errors: 7, elapsedSec: 187,
  sources: { yahoo: 880, ohlcdev: 15, cache: 10 },
  summary: { total: 4, high: 2, medium: 2, watchlist: 0 },
  candidates: [
    { ticker: 'BRMS.JK', name: 'Bumi Resources Minerals', last: 248, prob: 85, confidence: 'VERY_HIGH', signals: ['SWEEP_SELL','DEEP_DISCOUNT','BASE_FORMING','VOL_SPIKE_3.2x'], entry: 248, stopLoss: 240, tp1: 268, tp2: 282, profitPct: 8.1, rr: 2.5, riskPct: 3.2, hasSweep: true, baseForming: true, volOk: true, avgVol: 18500000, signalCount: 5 },
    { ticker: 'DMAS.JK', name: 'Puradelta Lestari', last: 196, prob: 70, confidence: 'HIGH', signals: ['SWEEP_SELL','DISCOUNT','HAMMER'], entry: 196, stopLoss: 189, tp1: 210, tp2: 224, profitPct: 7.1, rr: 2.0, riskPct: 3.6, hasSweep: true, baseForming: false, volOk: true, avgVol: 9200000, signalCount: 4 },
    { ticker: 'ZINC.JK', name: 'Kapuas Prima Coal', last: 312, prob: 50, confidence: 'MEDIUM', signals: ['DEEP_DISCOUNT','BASE_FORMING','VOL_DECLINING'], entry: 312, stopLoss: 302, tp1: 330, tp2: 345, profitPct: 5.8, rr: 1.8, riskPct: 3.2, hasSweep: false, baseForming: true, volOk: true, avgVol: 4100000, signalCount: 3 },
    { ticker: 'ARCI.JK', name: 'Archi Indonesia', last: 580, prob: 50, confidence: 'MEDIUM', signals: ['DISCOUNT','HIGHER_CLOSE_SWEEP_WICK','VOL_SPIKE_2.1x'], entry: 580, stopLoss: 560, tp1: 615, tp2: 640, profitPct: 6.0, rr: 1.8, riskPct: 3.4, hasSweep: false, baseForming: false, volOk: true, avgVol: 7800000, signalCount: 3 },
  ], _isSample: true,
}

// ═══════════════════════════════════════════════════════════════
//  SCANNER TAB COMPONENTS
// ═══════════════════════════════════════════════════════════════

function ProbBar({ prob }) {
  const color = probColor(prob)
  return (
    <div style={{ height: 3, background: 'var(--border)', borderRadius: 2, marginBottom: 14 }}>
      <div style={{ height: '100%', width: `${prob}%`, background: color, borderRadius: 2, transition: 'width 0.6s ease', boxShadow: `0 0 8px ${color}55` }} />
    </div>
  )
}

function Signal({ label }) {
  return (
    <span style={{ fontSize: 10, fontFamily: 'var(--mono)', fontWeight: 500, color: signalColor(label), background: signalColor(label) + '18', border: `1px solid ${signalColor(label)}30`, borderRadius: 3, padding: '2px 6px', whiteSpace: 'nowrap' }}>
      {label}
    </span>
  )
}

function StockCard({ r, rank }) {
  const badge = confidenceBadge(r.confidence)
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '16px 18px', display: 'flex', flexDirection: 'column' }}>
      <ProbBar prob={r.prob} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
        <div>
          <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>#{rank}</span>
          <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 15, color: 'var(--text)', marginLeft: 6 }}>{r.ticker.replace('.JK','')}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 10, fontFamily: 'var(--mono)', fontWeight: 700, color: badge.color, background: badge.color+'18', border: `1px solid ${badge.color}40`, borderRadius: 3, padding: '2px 7px' }}>{badge.label}</span>
          <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13, color: probColor(r.prob) }}>{r.prob}%</span>
        </div>
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 12 }}>{r.name}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px 8px', marginBottom: 12 }}>
        {[['LAST', fmt(r.last), 'var(--text)'], ['ENTRY', fmt(r.entry), 'var(--text)'], ['SL', fmt(r.stopLoss), 'var(--red)'], ['TP1', fmt(r.tp1), 'var(--green)'], ['TP2', fmt(r.tp2), '#27AE60'], ['AVG VOL', fmtVol(r.avgVol), 'var(--muted)']].map(([l, v, c]) => (
          <div key={l}><div style={{ fontSize: 9, color: 'var(--muted)', letterSpacing: '0.08em', marginBottom: 2 }}>{l}</div><div style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, color: c }}>{v}</div></div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 12, padding: '8px 10px', background: 'var(--bg)', borderRadius: 5 }}>
        {[['PROFIT', `+${r.profitPct}%`, 'var(--green)'], ['RISK', `-${r.riskPct}%`, 'var(--red)'], ['R:R', `1:${r.rr}`, r.rr >= 2 ? 'var(--green)' : 'var(--amber)']].map(([l, v, c]) => (
          <div key={l} style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: 9, color: 'var(--muted)', letterSpacing: '0.07em' }}>{l}</div>
            <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13, color: c }}>{v}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {(r.signals||[]).map(s => <Signal key={s} label={s} />)}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        {[['SWEEP', r.hasSweep, '#9B59B6'], ['BASE', r.baseForming, 'var(--amber)'], ['VOL OK', r.volOk, 'var(--green)']].map(([l, flag, c]) => (
          <span key={l} style={{ fontSize: 9, fontFamily: 'var(--mono)', color: flag ? c : 'var(--border)', opacity: flag ? 1 : 0.4 }}>{flag ? '●' : '○'} {l}</span>
        ))}
      </div>
    </div>
  )
}

function StatPill({ label, value, color }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '10px 16px', textAlign: 'center', minWidth: 80 }}>
      <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 20, color: color || 'var(--text)' }}>{value}</div>
      <div style={{ fontSize: 10, color: 'var(--muted)', letterSpacing: '0.07em', marginTop: 2 }}>{label}</div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
//  FUNDAMENTAL ANALYZER TAB
// ═══════════════════════════════════════════════════════════════

function MetricRow({ label, value, pass, tip }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border)' }} title={tip}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: pass === true ? 'var(--green)' : pass === false ? 'var(--red)' : 'var(--muted)' }}>
          {pass === true ? '✓' : pass === false ? '✗' : '·'}
        </span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{label}</span>
      </div>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 600, color: pass === true ? 'var(--green)' : pass === false ? 'var(--red)' : 'var(--text)' }}>{value}</span>
    </div>
  )
}

function SectionCard({ title, children }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '16px 18px', marginBottom: 14 }}>
      <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', letterSpacing: '0.1em', marginBottom: 12 }}>{title}</div>
      {children}
    </div>
  )
}

function FundamentalAnalyzer() {
  const [ticker,     setTicker]     = useState('')
  const [input,      setInput]      = useState('')
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState(null)
  const [fundData,   setFundData]   = useState(null)
  const [growthRate, setGrowthRate] = useState(8)   // % assumption for DCF
  const [discRate,   setDiscRate]   = useState(12)  // % discount rate for DCF

  async function fetchFundamentals(rawTicker) {
    const t = rawTicker.toUpperCase().replace('.JK','')
    setLoading(true); setError(null); setFundData(null)

    try {
      const res  = await fetch(FUNDAMENTAL_API(t))
      const data = await res.json()

      if (!res.ok) throw new Error(data.error || `Server error ${res.status}`)

      setFundData({
        ...data,
        sector:   data.sector   || '—',
        industry: data.industry || '—',
      })
      setTicker(t)
    } catch (e) {
      setError(e.message || 'Failed to fetch data')
    } finally {
      setLoading(false)
    }
  }

  function handleSearch() {
    if (!input.trim()) return
    fetchFundamentals(input.trim())
  }

  const analysis = useMemo(() => {
    if (!fundData) return null
    const { price, eps, bvps, pbv, per, roe, der, npm } = fundData
    const gr = growthRate / 100
    const dr = discRate   / 100

    const grahamNum = calcGrahamNumber(eps, bvps)
    const dcfValue  = calcDCF(eps, gr, dr)
    const lkh       = calcLKHChecklist({ pbv, per, roe, der, npm })
    const verdict   = getVerdict(price, grahamNum, dcfValue, lkh)

    return { grahamNum, dcfValue, lkh, verdict }
  }, [fundData, growthRate, discRate])

  return (
    <div>
      {/* ── SEARCH BAR ── */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 24, flexWrap: 'wrap' }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSearch()}
          placeholder="Enter ticker e.g. BBCA, ADRO, TLKM…"
          style={{ flex: 1, minWidth: 220, fontFamily: 'var(--mono)', fontSize: 13, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '10px 14px', color: 'var(--text)', outline: 'none' }}
        />
        <button onClick={handleSearch} style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', padding: '10px 20px', borderRadius: 6, background: 'var(--green)', color: '#0D0F14', border: 'none' }}>
          ANALYZE
        </button>
      </div>

      {/* ── LOADING ── */}
      {loading && (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
          Fetching {input.toUpperCase()} from Yahoo Finance…
        </div>
      )}

      {/* ── ERROR ── */}
      {error && (
        <div style={{ background: '#E74C3C15', border: '1px solid #E74C3C40', borderRadius: 6, padding: '12px 16px', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--red)', marginBottom: 16 }}>
          ⚠ {error}
          <div style={{ marginTop: 6, fontSize: 10, color: 'var(--muted)' }}>
            Try without .JK suffix · Small caps may have limited data on Yahoo Finance
          </div>
        </div>
      )}

      {/* ── RESULTS ── */}
      {fundData && analysis && (
        <div>
          {/* Company header */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
              <div>
                <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 22, color: 'var(--text)' }}>{fundData.ticker}</div>
                <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>{fundData.name}</div>
                <div style={{ fontSize: 11, color: 'var(--border)', marginTop: 4 }}>{fundData.sector} · {fundData.industry}</div>
              </div>
              {/* Verdict badge */}
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 22, color: analysis.verdict.color }}>
                  {analysis.verdict.verdict}
                </div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 18, color: 'var(--text)', marginTop: 2 }}>
                  {fmt(fundData.price)}
                </div>
                <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
                  52W: {fmt(fundData.low52)} — {fmt(fundData.high52)}
                </div>
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>

            {/* ── LO KHENG HONG CHECKLIST ── */}
            <SectionCard title="LO KHENG HONG CHECKLIST">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>Criteria passed</span>
                <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 18, color: analysis.lkh.passed >= 4 ? 'var(--green)' : analysis.lkh.passed >= 3 ? 'var(--amber)' : 'var(--red)' }}>
                  {analysis.lkh.passed}/{analysis.lkh.total}
                </span>
              </div>
              {analysis.lkh.checks.map(c => (
                <MetricRow key={c.label} label={c.label} value={c.value} pass={c.pass} tip={c.tip} />
              ))}
            </SectionCard>

            {/* ── INTRINSIC VALUE ── */}
            <SectionCard title="INTRINSIC VALUE">
              <MetricRow label="Current Price"   value={fmt(fundData.price)}              />
              <MetricRow label="Graham Number"   value={analysis.grahamNum ? fmt(Math.round(analysis.grahamNum)) : '—'}
                pass={analysis.grahamNum ? fundData.price < analysis.grahamNum : null} />
              <MetricRow label="Margin of Safety" value={analysis.grahamNum ? `${Math.round((analysis.grahamNum - fundData.price)/analysis.grahamNum*100)}%` : '—'}
                pass={analysis.grahamNum ? fundData.price < analysis.grahamNum * 0.7 : null} />
              <div style={{ marginTop: 14, padding: '10px 0 4px', borderTop: '1px solid var(--border)' }}>
                <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 8 }}>DCF ASSUMPTIONS</div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: 9, color: 'var(--muted)', marginBottom: 3 }}>GROWTH RATE</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input type="range" min={1} max={30} value={growthRate} onChange={e => setGrowthRate(Number(e.target.value))}
                        style={{ width: 80, accentColor: 'var(--green)' }} />
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--green)' }}>{growthRate}%</span>
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 9, color: 'var(--muted)', marginBottom: 3 }}>DISCOUNT RATE</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input type="range" min={6} max={20} value={discRate} onChange={e => setDiscRate(Number(e.target.value))}
                        style={{ width: 80, accentColor: 'var(--amber)' }} />
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--amber)' }}>{discRate}%</span>
                    </div>
                  </div>
                </div>
              </div>
              <div style={{ marginTop: 10 }}>
                <MetricRow label="DCF Fair Value (10Y)" value={analysis.dcfValue ? fmt(Math.round(analysis.dcfValue)) : '—'}
                  pass={analysis.dcfValue ? fundData.price < analysis.dcfValue : null} />
                <MetricRow label="EPS (TTM)"  value={fundData.eps  != null ? `Rp ${fmtN(fundData.eps,0)}` : '—'} />
                <MetricRow label="BVPS"       value={fundData.bvps != null ? `Rp ${fmtN(fundData.bvps,0)}` : '—'} />
              </div>
            </SectionCard>

            {/* ── VALUATION RATIOS ── */}
            <SectionCard title="VALUATION RATIOS">
              <MetricRow label="PBV"  value={fmtX(fundData.pbv)} pass={fundData.pbv != null ? fundData.pbv < 1 : null} />
              <MetricRow label="PER"  value={fmtX(fundData.per)} pass={fundData.per != null ? fundData.per < 10 : null} />
              <MetricRow label="Mkt Cap"     value={fmtB(fundData.mcap)}  />
              <MetricRow label="Revenue TTM" value={fmtB(fundData.rev)}   />
              <MetricRow label="Div Yield"   value={fundData.divY != null ? fmtPct(fundData.divY) : '—'} />
            </SectionCard>

            {/* ── PROFITABILITY ── */}
            <SectionCard title="PROFITABILITY & HEALTH">
              <MetricRow label="ROE"          value={fmtPct(fundData.roe)} pass={fundData.roe != null ? fundData.roe > 0.15 : null} />
              <MetricRow label="ROA"          value={fmtPct(fundData.roa)} pass={fundData.roa != null ? fundData.roa > 0.05 : null} />
              <MetricRow label="Net Margin"   value={fmtPct(fundData.npm)} pass={fundData.npm != null ? fundData.npm > 0.10 : null} />
              <MetricRow label="DER"          value={fmtX(fundData.der)}   pass={fundData.der != null ? fundData.der < 1 : null} />
              <MetricRow label="Current Ratio" value={fmtX(fundData.curr)} pass={fundData.curr != null ? fundData.curr > 1.5 : null} />
            </SectionCard>

            {/* ── VERDICT ── */}
            <SectionCard title="VERDICT">
              <div style={{ textAlign: 'center', padding: '8px 0 16px' }}>
                <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 28, color: analysis.verdict.color }}>
                  {analysis.verdict.verdict}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                  Score: {analysis.verdict.score > 0 ? '+' : ''}{analysis.verdict.score}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {analysis.verdict.signals.map((s, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ color: s.type === 'bull' ? 'var(--green)' : s.type === 'bear' ? 'var(--red)' : 'var(--amber)', fontSize: 12 }}>
                      {s.type === 'bull' ? '▲' : s.type === 'bear' ? '▼' : '→'}
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>{s.text}</span>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 16, padding: '10px', background: 'var(--bg)', borderRadius: 5, fontSize: 10, color: 'var(--border)', lineHeight: 1.6 }}>
                Based on Graham Number, DCF (10Y), and Lo Kheng Hong criteria.<br/>
                Not financial advice — always do your own research.
              </div>
            </SectionCard>

          </div>
        </div>
      )}

      {/* ── EMPTY STATE ── */}
      {!loading && !error && !fundData && (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--muted)', fontFamily: 'var(--mono)', lineHeight: 2 }}>
          Enter a ticker to begin fundamental analysis.<br/>
          <span style={{ fontSize: 11, color: 'var(--border)' }}>
            Try: BBCA · ADRO · ANTM · TLKM · BMRI · UNVR
          </span>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
//  MAIN APP
// ═══════════════════════════════════════════════════════════════

export default function App() {
  const [activeTab,  setActiveTab]  = useState('scanner')  // scanner | fundamental
  const [data,       setData]       = useState(null)
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState(null)
  const [filter,     setFilter]     = useState('ALL')
  const [search,     setSearch]     = useState('')
  const [sortBy,     setSortBy]     = useState('prob')

  useEffect(() => {
    fetch(DATA_URL)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then(d => { setData(d); setLoading(false) })
      .catch(() => { setData(SAMPLE); setLoading(false); setError('sample') })
  }, [])

  const candidates = useMemo(() => {
    if (!data) return []
    let list = [...(data.candidates || [])]
    if (filter === 'HIGH')      list = list.filter(r => r.prob >= 70)
    if (filter === 'MEDIUM')    list = list.filter(r => r.prob >= 50 && r.prob < 70)
    if (filter === 'WATCHLIST') list = list.filter(r => r.prob < 50)
    if (search.trim()) {
      const q = search.toUpperCase()
      list = list.filter(r => r.ticker.includes(q) || r.name.toUpperCase().includes(q) || (r.signals||[]).some(s => s.includes(q)))
    }
    list.sort((a, b) => b[sortBy] - a[sortBy])
    return list
  }, [data, filter, search, sortBy])

  const s = data?.summary || {}

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 16px 48px' }}>

      {/* ── HEADER ── */}
      <header style={{ borderBottom: '1px solid var(--border)', padding: '20px 0 16px', marginBottom: 24, display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12 }}>
        <div>
          <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 18, letterSpacing: '0.12em', color: 'var(--green)' }}>◈ ALCHEMIST</div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3, fontFamily: 'var(--mono)' }}>IDX SCANNER + FUNDAMENTAL ANALYZER</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>{loading ? 'Loading...' : fmtTime(data?.generatedAt)}</div>
          {data && <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--border)', marginTop: 2 }}>{data.scanned?.toLocaleString()} scanned · {data.elapsedSec}s · Y:{data.sources?.yahoo} O:{data.sources?.ohlcdev} C:{data.sources?.cache}</div>}
        </div>
      </header>

      {/* ── TABS ── */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 24, borderBottom: '1px solid var(--border)', paddingBottom: 0 }}>
        {[['scanner', '⬡ SCANNER'], ['fundamental', '◎ FUNDAMENTAL']].map(([key, label]) => (
          <button key={key} onClick={() => setActiveTab(key)} style={{
            fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
            padding: '8px 18px', borderRadius: '6px 6px 0 0',
            background: activeTab === key ? 'var(--surface)' : 'transparent',
            color: activeTab === key ? 'var(--green)' : 'var(--muted)',
            border: activeTab === key ? '1px solid var(--border)' : '1px solid transparent',
            borderBottom: activeTab === key ? '1px solid var(--surface)' : '1px solid transparent',
            marginBottom: activeTab === key ? -1 : 0,
          }}>{label}</button>
        ))}
      </div>

      {/* ── SCANNER TAB ── */}
      {activeTab === 'scanner' && (
        <>
          {error === 'sample' && (
            <div style={{ background: '#F39C1215', border: '1px solid #F39C1240', borderRadius: 6, padding: '10px 14px', marginBottom: 20, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--amber)' }}>
              ⚠ Showing sample data — run the scanner to generate results/latest.json
            </div>
          )}
          {data && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 24 }}>
              <StatPill label="TOTAL"     value={s.total     ?? 0} />
              <StatPill label="HIGH"      value={s.high      ?? 0} color="var(--green)" />
              <StatPill label="MEDIUM"    value={s.medium    ?? 0} color="var(--amber)" />
              <StatPill label="WATCHLIST" value={s.watchlist ?? 0} color="var(--muted)" />
              <StatPill label="UNIVERSE"  value={(data.universeSize ?? 0).toLocaleString()} />
              <StatPill label="ERRORS"    value={data.errors ?? 0}  color={data.errors > 20 ? 'var(--red)' : 'var(--muted)'} />
            </div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20, alignItems: 'center' }}>
            {['ALL','HIGH','MEDIUM','WATCHLIST'].map(f => (
              <button key={f} onClick={() => setFilter(f)} style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600, letterSpacing: '0.07em', padding: '6px 14px', borderRadius: 4, background: filter===f ? 'var(--green)' : 'var(--surface)', color: filter===f ? '#0D0F14' : 'var(--muted)', border: `1px solid ${filter===f ? 'var(--green)' : 'var(--border)'}` }}>{f}</button>
            ))}
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search ticker or signal…" style={{ fontFamily: 'var(--mono)', fontSize: 11, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 12px', color: 'var(--text)', outline: 'none', minWidth: 180 }} />
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>SORT</span>
              {[['prob','PROB'],['rr','R:R'],['profitPct','PROFIT']].map(([key, label]) => (
                <button key={key} onClick={() => setSortBy(key)} style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600, padding: '5px 10px', borderRadius: 4, background: sortBy===key ? 'var(--border)' : 'transparent', color: sortBy===key ? 'var(--text)' : 'var(--muted)', border: `1px solid ${sortBy===key ? 'var(--border)' : 'transparent'}` }}>{label}</button>
              ))}
            </div>
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 14 }}>
            {loading ? 'Fetching scan results…' : `${candidates.length} candidate${candidates.length !== 1 ? 's' : ''}`}
          </div>
          {loading ? (
            <div style={{ textAlign: 'center', padding: 60, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Loading scan results…</div>
          ) : candidates.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 60, color: 'var(--muted)', fontFamily: 'var(--mono)', lineHeight: 2 }}>No candidates found.<br/><span style={{ fontSize: 11 }}>Run the scanner or adjust filters.</span></div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
              {candidates.map((r, i) => <StockCard key={r.ticker} r={r} rank={i+1} />)}
            </div>
          )}
        </>
      )}

      {/* ── FUNDAMENTAL TAB ── */}
      {activeTab === 'fundamental' && <FundamentalAnalyzer />}

      {/* ── FOOTER ── */}
      <footer style={{ marginTop: 48, paddingTop: 16, borderTop: '1px solid var(--border)', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--border)', textAlign: 'center', lineHeight: 1.8 }}>
        ALCHEMIST v3 · Algorithmic signals only · Not financial advice<br/>
        Always verify with price action, news, and market conditions before entry
      </footer>
    </div>
  )
}
