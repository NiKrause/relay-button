import clsx from 'clsx'
import Link from '@docusaurus/Link'
import Layout from '@theme/Layout'

const cards = [
  {
    title: 'Shared Deploy Core',
    body: 'Common Aleph deployment, runtime, retry, and guest lifecycle logic lives in one place instead of being duplicated across consumer repos.',
    to: '/docs/architecture/deployment-lifecycle'
  },
  {
    title: 'Thin Adapters',
    body: 'Node, GitHub Actions, and later browser flows are meant to stay shallow wrappers around reusable core modules.',
    to: '/docs/architecture/package-boundaries'
  },
  {
    title: 'Automation Surface',
    body: 'The shared deploy action is already real, while the reusable rootfs workflow is intentionally still staged behind a placeholder contract.',
    to: '/docs/reference/github-action'
  }
]

export default function Home() {
  return (
    <Layout
      title="Shared Aleph Tooling"
      description="Shared Aleph VM deployment, rootfs, and automation tooling."
    >
      <header className="hero hero--shared">
        <div className="container">
          <h1 className="hero__title">Shared Aleph Tooling</h1>
          <p className="hero__subtitle">
            A shared foundation for Aleph VM deployment, rootfs automation, GitHub Actions,
            and future browser-driven deployment flows.
          </p>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '1.5rem' }}>
            <Link className="button button--primary button--lg" to="/docs/overview/">
              Read the docs
            </Link>
            <Link className="button button--secondary button--lg" to="/docs/reference/github-action">
              Action reference
            </Link>
          </div>
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
