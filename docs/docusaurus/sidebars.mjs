// Task-oriented navigation: a first-time reader should reach "how do I use
// this" before internal architecture. "How-to" holds the pages you act on,
// "Deep dives" the design/ops narratives you read once, "Design notes" the
// internal RFCs that describe proposals rather than shipped behaviour.
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
    {
      type: 'category',
      label: 'Design notes',
      collapsed: true,
      items: [
        'architecture/browser-extraction-plan',
        'architecture/browser-guest-setup-refactor-plan',
      ],
    },
    'reference/branding',
  ],
}

export default sidebars
