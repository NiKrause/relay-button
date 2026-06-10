const sidebars = {
  docsSidebar: [
    'overview/index',
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
      label: 'Reference',
      items: [
        'reference/aleph-bootstrap',
        'reference/aleph-bootstrap-sequences',
        'reference/aleph-bootstrap-operations',
        'reference/github-action',
        'reference/ui',
        'reference/rootfs-contract',
        'reference/reusable-workflow'
      ]
    }
  ]
}

export default sidebars
