import React, { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Router, Revision, Link, Icon, Empty } from './lib/common.js'
import { Overview } from './pages/Overview.js'
import { Sessions } from './pages/Sessions.js'
import { SessionDetail } from './pages/SessionDetail.js'
import { Battles } from './pages/Battles.js'
import { BattleDetail } from './pages/BattleDetail.js'
import { Leaderboard } from './pages/Leaderboard.js'
import { Agents } from './pages/Agents.js'
import './styles.css'

function App() {
  const [path, setPath] = useState(window.location.pathname)
  const [revision, setRevision] = useState(0)
  const [connection, setConnection] = useState<'connecting' | 'live' | 'reconnecting'>('connecting')
  const navigate = useCallback((target: string) => {
    window.history.pushState({}, '', target)
    setPath(target)
    window.scrollTo({ top: 0 })
  }, [])
  useEffect(() => {
    const pop = () => setPath(window.location.pathname)
    window.addEventListener('popstate', pop)
    return () => window.removeEventListener('popstate', pop)
  }, [])
  useEffect(() => {
    const stream = new EventSource('/api/stream')
    stream.addEventListener('ready', () => {
      setConnection('live')
      setRevision((value) => value + 1)
    })
    stream.addEventListener('update', () => {
      setRevision((value) => value + 1)
      setConnection('live')
    })
    stream.onerror = () => setConnection('reconnecting')
    return () => stream.close()
  }, [])
  const parts = path.split('/').filter(Boolean)
  const section = parts[0] ?? 'overview'
  const id = parts[1]
  const nav = [
    ['overview', '/', 'grid', 'Overview'],
    ['sessions', '/sessions', 'sessions', 'Sessions'],
    ['battles', '/battles', 'battle', 'Battles'],
    ['leaderboard', '/leaderboard', 'chart', 'Leaderboard'],
    ['agents', '/agents', 'agents', 'Agents']
  ]
  let page: React.ReactNode
  if (section === 'overview') page = <Overview />
  else if (section === 'sessions')
    page = id ? <SessionDetail key={id} id={encodeURIComponent(id)} /> : <Sessions />
  else if (section === 'battles')
    page = id ? <BattleDetail key={id} id={encodeURIComponent(id)} /> : <Battles />
  else if (section === 'leaderboard') page = <Leaderboard />
  else if (section === 'agents') page = <Agents />
  else
    page = (
      <Empty title="Page not found">
        <p>This local dashboard page does not exist.</p>
        <Link className="button secondary" to="/">
          Return to overview
        </Link>
      </Empty>
    )
  return (
    <Router.Provider value={{ path, navigate }}>
      <Revision.Provider value={revision}>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <div className="app-shell">
          <aside className="sidebar">
            <Link to="/" className="brand">
              <span className="brand-mark">
                <span>R</span>
                <i />
              </span>
              <span>
                Rival<span className="text-teal">Code</span>
                <small>THE LOCAL AGENT ARENA</small>
              </span>
            </Link>
            <div className="sidebar-section-label">WORKSPACE</div>
            <nav aria-label="Main navigation">
              {nav.map(([key, to, icon, title]) => (
                <Link
                  key={key}
                  to={to ?? '/'}
                  className={`nav-link ${section === key ? 'active' : ''}`}
                >
                  <Icon name={icon ?? 'grid'} />
                  <span>{title}</span>
                  {key === 'battles' && <span className="nav-new">ARENA</span>}
                </Link>
              ))}
            </nav>
            <div className="sidebar-bottom">
              <div className="local-card">
                <span className="local-indicator" />
                <div>
                  <strong>Local by design</strong>
                  <p>
                    Your code. Your machine.
                    <br />
                    Your evidence.
                  </p>
                </div>
                <Icon name="shield" size={18} />
              </div>
              <div className="sidebar-version">
                <span>RivalCode v0.1.0</span>
                <span>OPEN SOURCE</span>
              </div>
            </div>
          </aside>
          <div className="main-shell">
            <header className="topbar">
              <div className="breadcrumb">
                <span>Workspace</span>
                <span>/</span>
                <strong>
                  {nav.find((entry) => entry[0] === section)?.[3] ?? 'Page'}
                  {id ? ' / Detail' : ''}
                </strong>
              </div>
              <div className={`live-pill ${connection}`} role="status">
                <span className="status-dot" />
                {connection === 'live'
                  ? 'Live · localhost'
                  : connection === 'connecting'
                    ? 'Connecting to localhost'
                    : 'Reconnecting…'}
              </div>
            </header>
            <main id="main" className="content" tabIndex={-1}>
              {page}
            </main>
            <footer className="footer">
              <span>
                <Icon name="shield" size={14} />
                Private, local evidence. No telemetry.
              </span>
              <span>Benchmark on your code. Learn from every run.</span>
            </footer>
          </div>
        </div>
      </Revision.Provider>
    </Router.Provider>
  )
}
const root = document.getElementById('root')
if (!root) throw new Error('Dashboard root is missing.')
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
