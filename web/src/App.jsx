import { useState, useEffect, useMemo } from 'react'

// ─── CONFIG ──────────────────────────────────────────────────
// For local testing: put your latest.json in web/public/results/latest.json
// For production: change to your raw GitHub URL
const DATA_URL = import.meta.env.VITE_DATA_URL
  || 'https://raw.githubusercontent.com/chankvizard/alchemist/main/results/latest.json'

// ─── HELPERS ─────────────────────────────────────────────────
const fmt = (n) => n == null ? '—' : `Rp ${Number(n).toLocaleString('id-ID')}`
const fmtVol = (n) => {
  if (!n) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}
const fmtTime = (iso) => {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('id-ID', {
      timeZone: 'Asia/Jakarta',
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }) + ' WIB'
  } catch { return iso }
}

const probColor = (prob) => {
  if (prob >= 70) return 'var(--green)'
  if (prob >= 50) return 'var(--amber)'
  return 'var(--muted)'
}

const confidenceBadge = (conf) => {
  const map = {
    VERY_HIGH: { label: 'VERY HIGH', color: '#27AE60' },
    HIGH:      { label: 'HIGH',      color: 'var(--green)' },
    MEDIUM:    { label: 'MED',       color: 'var(--amber)' },
    LOW:       { label: 'LOW',       color: 'var(--muted)' },
  }
  return map[conf] || { label: conf || '—', color: 'var(--muted)' }
}

const signalColor = (sig) => {
  if (sig.startsWith('SWEEP'))         return '#9B59B6'
  if (sig.includes('DISCOUNT'))        return 'var(--green)'
  if (sig.includes('VOL_SPIKE'))       return 'var(--blue)'
  if (sig.includes('BASE') || sig.includes('TIGHT')) return 'var(--amber)'
  if (sig.includes('FREEFALL') || sig.includes('LOW_LIQ')) return 'var(--red)'
  if (sig.includes('HAMMER') || sig.includes('ENGULF') || sig.includes('HIGHER_CLOSE')) return '#1ABC9C'
  return 'var(--muted)'
}

// ─── SAMPLE DATA (shown when no real data yet) ────────────────
const SAMPLE = {
  generatedAt: new Date().toISOString(),
  scanDate: new Date().toISOString().slice(0, 10),
  universeSize: 912,
  scanned: 905,
  errors: 7,
  elapsedSec: 187,
  sources: { yahoo: 880, ohlcdev: 15, cache: 10 },
  summary: { total: 8, high: 2, medium: 4, watchlist: 2 },
  candidates: [
    { ticker: 'BRMS.JK', name: 'Bumi Resources Minerals', last: 248, prob: 85, confidence: 'VERY_HIGH',
      signals: ['SWEEP_SELL', 'DEEP_DISCOUNT', 'BASE_FORMING', 'VOL_SPIKE_3.2x'],
      entry: 248, stopLoss: 240, tp1: 268, tp2: 282, profitPct: 8.1, rr: 2.5, riskPct: 3.2,
      hasSweep: true, baseForming: true, volOk: true, avgVol: 18500000, signalCount: 5 },
    { ticker: 'DMAS.JK', name: 'Puradelta Lestari', last: 196, prob: 70, confidence: 'HIGH',
      signals: ['SWEEP_SELL', 'DISCOUNT', 'HAMMER'],
      entry: 196, stopLoss: 189, tp1: 210, tp2: 224, profitPct: 7.1, rr: 2.0, riskPct: 3.6,
      hasSweep: true, baseForming: false, volOk: true, avgVol: 9200000, signalCount: 4 },
    { ticker: 'ZINC.JK', name: 'Kapuas Prima Coal', last: 312, prob: 50, confidence: 'MEDIUM',
      signals: ['DEEP_DISCOUNT', 'BASE_FORMING', 'VOL_DECLINING'],
      entry: 312, stopLoss: 302, tp1: 330, tp2: 345, profitPct: 5.8, rr: 1.8, riskPct: 3.2,
      hasSweep: false, baseForming: true, volOk: true, avgVol: 4100000, signalCount: 3 },
    { ticker: 'ARCI.JK', name: 'Archi Indonesia', last: 580, prob: 50, confidence: 'MEDIUM',
      signals: ['DISCOUNT', 'HIGHER_CLOSE_SWEEP_WICK', 'VOL_SPIKE_2.1x'],
      entry: 580, stopLoss: 560, tp1: 615, tp2: 640, profitPct: 6.0, rr: 1.8, riskPct: 3.4,
      hasSweep: false, baseForming: false, volOk: true, avgVol: 7800000, signalCount: 3 },
  ],
  _isSample: true,
}

// ─── COMPONENTS ──────────────────────────────────────────────

function ProbBar({ prob }) {
  const color = probColor(prob)
  return (
    <div style={{ height: 3, background: 'var(--border)', borderRadius: 2, marginBottom: 14 }}>
      <div style={{
        height: '100%', width: `${prob}%`, background: color,
        borderRadius: 2, transition: 'width 0.6s ease',
        boxShadow: `0 0 8px ${color}55`,
      }} />
    </div>
  )
}

function Signal({ label }) {
  return (
    <span style={{
      fontSize: 10, fontFamily: 'var(--mono)', fontWeight: 500,
      color: signalColor(label),
      background: signalColor(label) + '18',
      border: `1px solid ${signalColor(label)}30`,
      borderRadius: 3, padding: '2px 6px',
      whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  )
}

function StockCard({ r, rank }) {
  const badge = confidenceBadge(r.confidence)
  const slPct = r.riskPct ? `-${r.riskPct}%` : '—'

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 8, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 0,
    }}>
      <ProbBar prob={r.prob} />

      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
        <div>
          <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
            #{rank}
          </span>
          <span style={{
            fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 15,
            color: 'var(--text)', marginLeft: 6,
          }}>
            {r.ticker.replace('.JK', '')}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            fontSize: 10, fontFamily: 'var(--mono)', fontWeight: 700,
            color: badge.color, background: badge.color + '18',
            border: `1px solid ${badge.color}40`,
            borderRadius: 3, padding: '2px 7px', letterSpacing: '0.05em',
          }}>
            {badge.label}
          </span>
          <span style={{
            fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13,
            color: probColor(r.prob),
          }}>
            {r.prob}%
          </span>
        </div>
      </div>

      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 12 }}>
        {r.name}
      </div>

      {/* Price grid */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr 1fr',
        gap: '10px 8px', marginBottom: 12,
      }}>
        {[
          { label: 'LAST',  val: fmt(r.last),     color: 'var(--text)' },
          { label: 'ENTRY', val: fmt(r.entry),    color: 'var(--text)' },
          { label: 'SL',    val: fmt(r.stopLoss), color: 'var(--red)'  },
          { label: 'TP1',   val: fmt(r.tp1),      color: 'var(--green)'},
          { label: 'TP2',   val: fmt(r.tp2),      color: '#27AE60'     },
          { label: 'AVG VOL', val: fmtVol(r.avgVol), color: 'var(--muted)' },
        ].map(({ label, val, color }) => (
          <div key={label}>
            <div style={{ fontSize: 9, color: 'var(--muted)', letterSpacing: '0.08em', marginBottom: 2 }}>
              {label}
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, color }}>
              {val}
            </div>
          </div>
        ))}
      </div>

      {/* Stats row */}
      <div style={{
        display: 'flex', gap: 12, marginBottom: 12,
        padding: '8px 10px', background: 'var(--bg)', borderRadius: 5,
      }}>
        {[
          { label: 'PROFIT', val: `+${r.profitPct}%`, color: 'var(--green)' },
          { label: 'RISK',   val: slPct,               color: 'var(--red)'   },
          { label: 'R:R',    val: `1:${r.rr}`,         color: r.rr >= 2 ? 'var(--green)' : 'var(--amber)' },
        ].map(({ label, val, color }) => (
          <div key={label} style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: 9, color: 'var(--muted)', letterSpacing: '0.07em' }}>{label}</div>
            <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13, color }}>{val}</div>
          </div>
        ))}
      </div>

      {/* Signals */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {(r.signals || []).map((s) => <Signal key={s} label={s} />)}
      </div>

      {/* Flags */}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        {[
          { flag: r.hasSweep,    label: 'SWEEP',  color: '#9B59B6' },
          { flag: r.baseForming, label: 'BASE',   color: 'var(--amber)' },
          { flag: r.volOk,       label: 'VOL OK', color: 'var(--green)' },
        ].map(({ flag, label, color }) => (
          <span key={label} style={{
            fontSize: 9, fontFamily: 'var(--mono)', letterSpacing: '0.06em',
            color: flag ? color : 'var(--border)',
            opacity: flag ? 1 : 0.4,
          }}>
            {flag ? '●' : '○'} {label}
          </span>
        ))}
      </div>
    </div>
  )
}

function StatPill({ label, value, color }) {
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 6, padding: '10px 16px', textAlign: 'center', minWidth: 80,
    }}>
      <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 20, color: color || 'var(--text)' }}>
        {value}
      </div>
      <div style={{ fontSize: 10, color: 'var(--muted)', letterSpacing: '0.07em', marginTop: 2 }}>
        {label}
      </div>
    </div>
  )
}

// ─── MAIN APP ────────────────────────────────────────────────
export default function App() {
  const [data, setData]       = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  const [filter, setFilter]   = useState('ALL')   // ALL | HIGH | MEDIUM | WATCHLIST
  const [search, setSearch]   = useState('')
  const [sortBy, setSortBy]   = useState('prob')  // prob | rr | profitPct

  useEffect(() => {
    fetch(DATA_URL)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then((d) => { setData(d); setLoading(false) })
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
      list = list.filter(r =>
        r.ticker.includes(q) || r.name.toUpperCase().includes(q) ||
        (r.signals || []).some(s => s.includes(q))
      )
    }

    list.sort((a, b) => b[sortBy] - a[sortBy])
    return list
  }, [data, filter, search, sortBy])

  const s = data?.summary || {}

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 16px 48px' }}>

      {/* ── HEADER ── */}
      <header style={{
        borderBottom: '1px solid var(--border)',
        padding: '20px 0 16px',
        marginBottom: 24,
        display: 'flex', flexWrap: 'wrap',
        justifyContent: 'space-between', alignItems: 'flex-end', gap: 12,
      }}>
        <div>
          <div style={{
            fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 18, letterSpacing: '0.12em',
            color: 'var(--green)',
          }}>
            ◈ ALCHEMIST
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3, fontFamily: 'var(--mono)' }}>
            IDX PRE-MARKET SCALP SCANNER
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>
            {loading ? 'Loading...' : fmtTime(data?.generatedAt)}
          </div>
          {data && (
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--border)', marginTop: 2 }}>
              {data.scanned?.toLocaleString()} scanned · {data.elapsedSec}s
              · Y:{data.sources?.yahoo} O:{data.sources?.ohlcdev} C:{data.sources?.cache}
            </div>
          )}
        </div>
      </header>

      {/* ── SAMPLE WARNING ── */}
      {error === 'sample' && (
        <div style={{
          background: '#F39C1215', border: '1px solid #F39C1240',
          borderRadius: 6, padding: '10px 14px', marginBottom: 20,
          fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--amber)',
        }}>
          ⚠ Showing sample data — run the scanner to generate results/latest.json
        </div>
      )}

      {/* ── SUMMARY PILLS ── */}
      {data && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 24 }}>
          <StatPill label="TOTAL"     value={s.total     ?? 0}                         />
          <StatPill label="HIGH"      value={s.high      ?? 0} color="var(--green)"   />
          <StatPill label="MEDIUM"    value={s.medium    ?? 0} color="var(--amber)"   />
          <StatPill label="WATCHLIST" value={s.watchlist ?? 0} color="var(--muted)"   />
          <StatPill label="UNIVERSE"  value={(data.universeSize ?? 0).toLocaleString()} />
          <StatPill label="ERRORS"    value={data.errors ?? 0}  color={data.errors > 20 ? 'var(--red)' : 'var(--muted)'} />
        </div>
      )}

      {/* ── CONTROLS ── */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20, alignItems: 'center',
      }}>
        {/* Filter tabs */}
        {['ALL', 'HIGH', 'MEDIUM', 'WATCHLIST'].map((f) => (
          <button key={f} onClick={() => setFilter(f)} style={{
            fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
            letterSpacing: '0.07em',
            padding: '6px 14px', borderRadius: 4,
            background: filter === f ? 'var(--green)' : 'var(--surface)',
            color:      filter === f ? '#0D0F14'       : 'var(--muted)',
            border: `1px solid ${filter === f ? 'var(--green)' : 'var(--border)'}`,
            transition: 'all 0.15s',
          }}>
            {f}
          </button>
        ))}

        {/* Search */}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search ticker or signal…"
          style={{
            fontFamily: 'var(--mono)', fontSize: 11,
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 4, padding: '6px 12px', color: 'var(--text)',
            outline: 'none', minWidth: 180,
          }}
        />

        {/* Sort */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>SORT</span>
          {[['prob','PROB'], ['rr','R:R'], ['profitPct','PROFIT']].map(([key, label]) => (
            <button key={key} onClick={() => setSortBy(key)} style={{
              fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
              padding: '5px 10px', borderRadius: 4,
              background: sortBy === key ? 'var(--border)' : 'transparent',
              color: sortBy === key ? 'var(--text)' : 'var(--muted)',
              border: `1px solid ${sortBy === key ? 'var(--border)' : 'transparent'}`,
            }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── RESULTS COUNT ── */}
      <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 14 }}>
        {loading ? 'Fetching scan results…' : `${candidates.length} candidate${candidates.length !== 1 ? 's' : ''}`}
      </div>

      {/* ── CARD GRID ── */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
          Loading scan results…
        </div>
      ) : candidates.length === 0 ? (
        <div style={{
          textAlign: 'center', padding: 60, color: 'var(--muted)',
          fontFamily: 'var(--mono)', lineHeight: 2,
        }}>
          No candidates found.<br />
          <span style={{ fontSize: 11 }}>Run the scanner or adjust filters.</span>
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
          gap: 14,
        }}>
          {candidates.map((r, i) => (
            <StockCard key={r.ticker} r={r} rank={i + 1} />
          ))}
        </div>
      )}

      {/* ── FOOTER ── */}
      <footer style={{
        marginTop: 48, paddingTop: 16, borderTop: '1px solid var(--border)',
        fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--border)',
        textAlign: 'center', lineHeight: 1.8,
      }}>
        ALCHEMIST v3 · Algorithmic signals only · Not financial advice<br />
        Always verify with price action, news, and market conditions before entry
      </footer>
    </div>
  )
}
