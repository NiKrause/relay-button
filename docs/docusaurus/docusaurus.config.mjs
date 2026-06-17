import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const configDir = fileURLToPath(new URL('.', import.meta.url))
const nodePackage = JSON.parse(
  readFileSync(join(configDir, '..', '..', 'packages', 'node', 'package.json'), 'utf8')
)
const packageVersion = nodePackage.version

const config = {
  title: 'Relay Button',
  tagline: 'Relay deployment, rootfs, and automation tooling',
  favicon: 'img/favicon.svg',
  url: 'https://nikrause.github.io',
  baseUrl: '/relay-button/',
  organizationName: 'NiKrause',
  projectName: 'relay-button',
  onBrokenLinks: 'throw',
  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: 'throw'
    }
  },
  themes: ['@docusaurus/theme-mermaid'],
  presets: [
    [
      'classic',
      {
        docs: {
          path: 'docs',
          routeBasePath: 'docs',
          sidebarPath: './sidebars.mjs',
          showLastUpdateTime: true
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css'
        }
      }
    ]
  ],
  customFields: {
    packageVersion
  },
  themeConfig: {
    navbar: {
      title: 'Relay Button',
      logo: {
        alt: 'Relay Button',
        src: 'img/favicon.svg'
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Docs'
        },
        {
          to: '/docs/overview/',
          position: 'right',
          label: `v${packageVersion}`
        }
      ]
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {
              label: 'Overview',
              to: '/docs/overview/'
            },
            {
              label: 'Deployment Lifecycle',
              to: '/docs/architecture/deployment-lifecycle'
            }
          ]
        },
        {
          title: 'Reference',
          items: [
            {
              label: 'GitHub Action',
              to: '/docs/reference/github-action'
            },
            {
              label: 'Reusable Workflow',
              to: '/docs/reference/reusable-workflow'
            }
          ]
        }
      ],
      copyright: `Copyright ${new Date().getFullYear()} Relay Button · Current package version v${packageVersion}`
    },
    colorMode: {
      defaultMode: 'light',
      disableSwitch: false,
      respectPrefersColorScheme: true
    },
    prism: {
      additionalLanguages: ['bash', 'yaml', 'json']
    }
  }
}

export default config
