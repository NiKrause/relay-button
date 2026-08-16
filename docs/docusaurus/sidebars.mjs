// Task-oriented navigation: a first-time reader should reach "how do I use
// this" before internal architecture. "How-to" holds the pages you act on,
// "Deep dives" the design/ops narratives you read once.
//
// Every page here describes shipped behaviour. Proposals belong in the issue
// tracker, not in a docs category — a reader cannot tell a plan from a fact
// once both are rendered as a docs page, and stale plans quietly discredit the
// pages around them.
const sidebars = {
  docsSidebar: [
    'overview/index',
    'getting-started',
    {
      type: 'category',
      label: 'How-to',
      collapsed: false,
      items: [
        'guides/ai-agent-recipes',
        'reference/ui',
        'reference/browser',
        'reference/core',
        'reference/node-cli',
        'reference/github-action',
        'reference/reusable-workflow',
        'reference/static-sites-custom-domains',
        'reference/playwright-testkit',
        'guides/playwright-testkit-migration',
      ],
    },
    {
      type: 'category',
      label: 'Architecture',
      items: [
        'architecture/package-boundaries',
        'architecture/deployment-lifecycle',
        'architecture/examples-and-integrations',
        'architecture/aleph-playwright-runner',
      ],
    },
    {
      type: 'category',
      label: 'Deep dives',
      items: [
        'reference/aleph-bootstrap',
        'reference/aleph-bootstrap-sequences',
        'reference/deployment-paths',
        'reference/crn-discovery',
        'reference/guest-configuration-handoff',
        'reference/relay-dialability-timeline',
        'reference/rootfs-contract',
        'reference/aleph-bootstrap-operations',
      ],
    },
    'reference/branding',
  ],
}

export default sidebars
