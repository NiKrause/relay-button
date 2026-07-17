const sidebars = {
  docsSidebar: [
    'overview/index',
    'overview/filecoin-propgf-batch-3-application-draft',
    {
      type: 'category',
      label: 'Architecture',
      items: [
        'architecture/package-boundaries',
        'architecture/deployment-lifecycle'
      ]
    },
    {
      type: 'category',
      label: 'Guides',
      items: [
        'guides/playwright-testkit-migration'
      ]
    },
    {
      type: 'category',
      label: 'Reference',
      items: [
        'reference/aleph-bootstrap',
        'reference/aleph-bootstrap-sequences',
        'reference/aleph-bootstrap-operations',
        'reference/github-action',
        'reference/playwright-testkit',
        'reference/ui',
        'reference/rootfs-contract',
        'reference/reusable-workflow'
      ]
    }
  ]
}

export default sidebars
