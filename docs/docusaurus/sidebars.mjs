const sidebars = {
  docsSidebar: [
    'overview/index',
    {
      type: 'category',
      label: 'Architecture',
      items: ['architecture/package-boundaries', 'architecture/deployment-lifecycle', 'architecture/aleph-playwright-runner'],
    },
    {
      type: 'category',
      label: 'Guides',
      items: ['guides/playwright-testkit-migration'],
    },
    {
      type: 'category',
      label: 'Reference',
      items: [
        'reference/aleph-bootstrap',
        'reference/aleph-bootstrap-sequences',
        'reference/aleph-bootstrap-operations',
        'reference/deployment-paths',
        'reference/guest-configuration-handoff',
        'reference/relay-dialability-timeline',
        'reference/github-action',
        'reference/playwright-testkit',
        'reference/ui',
        'reference/rootfs-contract',
        'reference/reusable-workflow',
      ],
    },
  ],
}

export default sidebars
