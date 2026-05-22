import { validateRootfsManifest } from '../../../browser/src/rootfs.ts'
import type { RootfsManifest, RootfsManifestState } from '../../../browser/src/types.ts'

export function resolveManifestSource(args: {
  manifestJson: string
}): RootfsManifestState | null {
  const trimmed = args.manifestJson.trim()
  if (!trimmed) return null

  try {
    return validateRootfsManifest(JSON.parse(trimmed) as RootfsManifest)
  } catch (error) {
    return {
      manifest: null,
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)]
    }
  }
}
