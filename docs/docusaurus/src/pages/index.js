import clsx from 'clsx'
import Link from '@docusaurus/Link'
import useDocusaurusContext from '@docusaurus/useDocusaurusContext'
import CodeBlock from '@theme/CodeBlock'
import Layout from '@theme/Layout'

const capabilities = [
  {
    title: 'Build RootFS Images',
    body: 'Plan and build qcow2 images from project-specific contracts and reference rootfs assets.',
    to: '/docs/reference/rootfs-contract'
  },
  {
    title: 'Publish To Aleph/IPFS',
    body: 'Upload RootFS artifacts, publish signed Aleph STORE records, and emit reusable manifests.',
    to: '/docs/reference/node-cli'
  },
  {
    title: 'Deploy Aleph VMs',
    body: 'Create INSTANCE messages, select CRNs, wait for runtime networking, and configure the guest.',
    to: '/docs/architecture/deployment-lifecycle'
  },
  {
    title: 'Use GitHub Actions',
    body: 'Call the same deployment and RootFS runners from CI without copying Aleph workflow logic.',
    to: '/docs/reference/github-action'
  },
  {
    title: 'Embed Browser Flows',
    body: 'Use browser and UI packages for wallet-backed sponsor deployment and status surfaces.',
    to: '/docs/reference/ui'
  },
  {
    title: 'Keep Deployments Tidy',
    body: 'Refresh relay bootstrap records, verify deployed services, and forget old self-owned records.',
    to: '/docs/reference/aleph-bootstrap-operations'
  }
]

const workflowSteps = [
  'Build a qcow2 RootFS image',
  'Publish and pin it on Aleph/IPFS',
  'Deploy an Aleph VM INSTANCE',
  'Wait for CRN runtime and mapped ports',
  'Configure and verify the guest service',
  'Publish bootstrap and deployment records'
]

export default function Home() {
  const { siteConfig } = useDocusaurusContext()
  const packageVersion = siteConfig.customFields?.packageVersion

  return (
    <Layout
      title="Relay Button"
      description="Reusable Aleph Cloud deployment tooling for RootFS publishing, VM relay deployment, runtime verification, and browser sponsor flows."
    >
      <header className="hero hero--shared">
        <div className="container">
          <p className="hero__kicker">CLI · GitHub Actions · Browser UI</p>
          <h1 className="hero__title">Relay Button</h1>
          <p className="hero__subtitle">
            Reusable Aleph Cloud deployment tooling for RootFS publishing, VM relay deployment,
            runtime verification, and browser-driven sponsor flows.
          </p>
          <p className="hero__description">
            Use it when a consumer project needs Aleph deployment behavior without copying the
            STORE, INSTANCE, CRN, guest setup, bootstrap, and cleanup logic into every repo.
          </p>
          <div className="hero__actions">
            <Link className="button button--primary button--lg" to="/docs/reference/node-cli">
              Start with the CLI
            </Link>
            <Link className="button button--secondary button--lg" to="/docs/reference/github-action">
              Use the GitHub Action
            </Link>
            <Link className="button button--secondary button--lg" to="/docs/reference/ui">
              Embed the UI
            </Link>
          </div>
          <p className="hero__version">Current package version: v{packageVersion}</p>

          <section className="shared-cli">
            <div className="shared-cli__copy">
              <p className="shared-cli__eyebrow">Command line</p>
              <h2>Run deployment flows locally</h2>
              <p>
                The <code>relay-button</code> CLI exposes the same Node runner paths used by CI:
                RootFS build and publish, Aleph VM deployment, CRN discovery, and retention.
              </p>
              <p>
                Start with <code>deploy</code> for Aleph VM instances, <code>rootfs-publish</code>{' '}
                for qcow2 RootFS publication, and <code>list-crns</code> when you want to inspect
                candidate CRNs first.
              </p>
              <Link className="button button--secondary" to="/docs/reference/node-cli">
                Full Node CLI reference
              </Link>
            </div>
            <div className="shared-cli__code">
              <CodeBlock language="bash">{`pnpm relay-button help
pnpm relay-button deploy
pnpm relay-button rootfs-publish
pnpm exec relay-button list-crns | jq`}</CodeBlock>
            </div>
          </section>

          <section className="shared-flow" aria-labelledby="workflow-heading">
            <div>
              <p className="shared-cli__eyebrow">Deployment lifecycle</p>
              <h2 id="workflow-heading">What Relay Button automates</h2>
              <p>
                Relay Button connects the steps that usually make Aleph relay and service deployment
                fragile when every consumer repo owns them separately.
              </p>
            </div>
            <ol className="shared-flow__steps">
              {workflowSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </section>

          <section className="shared-grid">
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
