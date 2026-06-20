import clsx from 'clsx'
import Link from '@docusaurus/Link'
import useDocusaurusContext from '@docusaurus/useDocusaurusContext'
import CodeBlock from '@theme/CodeBlock'
import Layout from '@theme/Layout'

const cards = [
  {
    title: 'Shared Deploy Core',
    body: 'Common relay deployment, runtime, retry, and guest lifecycle logic lives in one place instead of being duplicated across consumer repos.',
    to: '/docs/architecture/deployment-lifecycle'
  },
  {
    title: 'Thin Adapters',
    body: 'Node, GitHub Actions, and later browser flows are meant to stay shallow wrappers around reusable core modules.',
    to: '/docs/architecture/package-boundaries'
  },
  {
    title: 'Automation Surface',
    body: 'The shared deploy action and reusable RootFS workflow are both real, with VM deployment still intentionally kept outside the reusable workflow path.',
    to: '/docs/reference/github-action'
  }
]

export default function Home() {
  const { siteConfig } = useDocusaurusContext()
  const packageVersion = siteConfig.customFields?.packageVersion

  return (
    <Layout
      title="Relay Button"
      description="Relay deployment, rootfs, and automation tooling."
    >
      <header className="hero hero--shared">
        <div className="container">
          <h1 className="hero__title">Relay Button</h1>
          <p className="hero__subtitle">
            A foundation for relay and node deployment, Aleph Cloud rootfs automation, GitHub Actions,
            and future browser-driven deployment flows.
          </p>
          <p style={{ marginTop: '0.75rem', fontWeight: 600 }}>
            Current package version: v{packageVersion}
          </p>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '1.5rem' }}>
            <Link className="button button--primary button--lg" to="/docs/overview/">
              Read the docs
            </Link>
            <Link className="button button--secondary button--lg" to="/docs/reference/github-action">
              Action reference
            </Link>
          </div>
          <section className="shared-cli">
            <div className="shared-cli__copy">
              <p className="shared-cli__eyebrow">Command line</p>
              <h2>Run the VM and RootFS flows locally</h2>
              <p>
                The root <code>package.json</code> exposes the <code>relay-button</code> and{' '}
                <code>relay-button</code> CLI entrypoints, so the homepage now surfaces the same
                VM deploy and RootFS publish commands available in the workspace scripts.
              </p>
              <p>
                Start with <code>deploy</code> for Aleph VM instances, <code>rootfs-publish</code>{' '}
                for qcow2/rootfs publication, and <code>list-crns</code> when you want to inspect
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
              <p className="shared-cli__note">
                Compatibility alias: <code>pnpm exec shared-aleph list-crns | jq</code>
              </p>
            </div>
          </section>
          <section className="shared-grid">
            {cards.map((card) => (
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
