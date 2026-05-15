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
        'reference/github-action',
        'reference/rootfs-contract',
        'reference/reusable-workflow'
      ]
    }
  ]
}

export default sidebars
