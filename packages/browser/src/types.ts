export type BrowserExtractionPhase = 'planned' | 'scaffolded'

export interface BrowserPackagePlan {
  phase: BrowserExtractionPhase
  modules: string[]
}

export const BROWSER_PACKAGE_PLAN: BrowserPackagePlan = {
  phase: 'scaffolded',
  modules: ['http', 'aleph-api', 'rootfs', 'pricing']
}
