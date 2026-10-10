import { Agent, Status, State, PageHeading, useApi } from '../lib/common.js'
import type { AgentDetection } from '@rivalcode/shared'

export function Agents() {
  const query = useApi<AgentDetection[]>('/api/agents')
  return (
    <>
      <PageHeading eyebrow="LOCAL INTEGRATIONS" title="Your agent toolkit">
        Installed CLI detection and the capabilities each adapter can capture.
      </PageHeading>
      <State {...query} />
      {query.data && (
        <div className="agent-cards">
          {query.data.map((agent) => (
            <section className="panel adapter-card" key={agent.id}>
              <div className="adapter-heading">
                <Agent id={agent.id} />
                <Status status={agent.installed ? 'completed' : 'missing'} />
              </div>
              <p className="subtext">
                {agent.version ?? 'Version unavailable'} · authentication {agent.auth}
              </p>
              {agent.detail && <p className="adapter-detail">{agent.detail}</p>}
              <div className="capability-list">
                {Object.entries(agent.capabilities).map(([key, enabled]) => (
                  <div key={key}>
                    <span>{key.replaceAll(/([A-Z])/g, ' $1').toLowerCase()}</span>
                    <span className={enabled ? 'text-teal' : 'muted'}>
                      {enabled ? 'Supported' : 'Unavailable'}
                    </span>
                  </div>
                ))}
              </div>
              <p className="fidelity-note">
                Capture fidelity: {agent.capabilities.structuredEvents ? 'High' : 'Standard'} ·
                adapter availability is detected locally.
              </p>
            </section>
          ))}
        </div>
      )}
      <p className="footnote">
        RivalCode uses your locally installed agents and credentials. Start runs from the CLI in the
        repository you want to measure.
      </p>
    </>
  )
}
