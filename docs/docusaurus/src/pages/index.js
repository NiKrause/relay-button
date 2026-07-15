import clsx from 'clsx'
import Link from '@docusaurus/Link'
import useDocusaurusContext from '@docusaurus/useDocusaurusContext'
import Layout from '@theme/Layout'

const capabilities = [
  {
    title: 'Distribute the app freely',
    body: 'Host the PWA on IPFS, offer a normal download, or share it through offline media such as a USB drive.',
    to: '/docs/overview'
  },
  {
    title: 'Keep primary data local',
    body: 'Users keep their working data on their own devices instead of depending on a central cloud database.',
    to: '/docs/overview'
  },
  {
    title: 'Collaborate peer to peer',
    body: 'Chats, todo lists, and other apps can exchange and replicate changes directly between peers.',
    to: '/docs/architecture/deployment-lifecycle'
  },
  {
    title: 'Start a relay on demand',
    body: 'Deploy signaling and bootstrap infrastructure only when a team needs help connecting across the internet.',
    to: '/docs/reference/ui'
  },
  {
    title: 'Keep shared data available',
    body: 'Use an online IPFS node to pin selected data while individual collaborators and their devices are offline.',
    to: '/docs/reference/aleph-bootstrap-operations'
  },
  {
    title: 'Add durable archives',
    body: 'Extend local replication and IPFS pinning with decentralized archival storage when long-term retention matters.',
    to: '/docs/overview'
  }
]

const workflowSteps = [
  'Open the PWA from IPFS, a download, or offline media',
  'Create and keep the primary working data locally',
  'Press Relay Button when the team needs to collaborate',
  'Deploy an OrbitDB and libp2p relay on Aleph Cloud',
  'Discover peers and replicate changes peer to peer',
  'Stop the relay when shared infrastructure is no longer useful'
]

export default function Home() {
  const { siteConfig } = useDocusaurusContext()
  const packageVersion = siteConfig.customFields?.packageVersion

  return (
    <Layout
      title="Relay Button"
      description="Local-first apps work on their own. Relay Button starts peer-to-peer collaboration and IPFS infrastructure only when it is needed."
    >
      <header className="hero hero--shared">
        <div className="container">
          <p className="hero__kicker">Local-first · Peer-to-peer · Infrastructure on demand</p>
          <h1 className="hero__title">Relay Button</h1>
          <p className="hero__subtitle">
            Your app works locally. Start shared infrastructure only when collaboration needs it.
          </p>
          <p className="hero__description">
            Distribute a local-first PWA through IPFS, a normal download, or even a USB drive.
            Users keep their primary data on their own devices and exchange changes peer to peer.
            When they need help finding each other—or an online node to pin shared data—they press
            the Relay Button.
          </p>
          <div className="hero__actions">
            <Link className="button button--primary button--lg" to="/docs/overview">
              Understand how it works
            </Link>
            <Link className="button button--secondary button--lg" to="/docs/reference/ui">
              Embed the Relay Button
            </Link>
            <Link
              className="button button--secondary button--lg"
              to="/docs/architecture/deployment-lifecycle"
            >
              Open the developer guide
            </Link>
          </div>
          <p className="hero__version">Current package version: v{packageVersion}</p>

          <section className="shared-cli" aria-label="Relay Button principles">
            <div className="shared-cli__copy">
              <p className="shared-cli__eyebrow">Application first</p>
              <h2>Software that stays with its users</h2>
              <p>
                Like software once distributed on a CD, a local-first PWA can remain usable without
                a permanent connection to its original publisher. The interface and working data
                live with the user, not exclusively behind a provider account.
              </p>
              <Link className="button button--secondary" to="/docs/overview">
                Read the full story
              </Link>
            </div>
            <div className="shared-cli__code">
              <p className="shared-cli__eyebrow">Infrastructure second</p>
              <h2>Connect only when collaboration needs it</h2>
              <p>
                Real networks still need signaling and bootstrap services. Relay Button deploys an
                OrbitDB and libp2p relay on Aleph Cloud for discovery, peer-to-peer collaboration,
                and optional IPFS pinning. Run it for minutes or years, then stop it again.
              </p>
            </div>
          </section>

          <section className="shared-flow" aria-labelledby="workflow-heading">
            <div>
              <p className="shared-cli__eyebrow">From local app to collaboration</p>
              <h2 id="workflow-heading">What happens when you press the button</h2>
              <p>
                Relay Button does not move the application into the cloud. It adds replaceable,
                internet-reachable infrastructure around an app that already works locally.
              </p>
            </div>
            <ol className="shared-flow__steps">
              {workflowSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </section>

          <section className="shared-grid" aria-label="Relay Button capabilities">
            {capabilities.map((card) => (
              <Link key={card.title} className={clsx('shared-card')} to={card.to}>
                <h3>{card.title}</h3>
                <p>{card.body}</p>
              </Link>
            ))}
          </section>
        </div>
      </header>
    </Layout>
  )
}
