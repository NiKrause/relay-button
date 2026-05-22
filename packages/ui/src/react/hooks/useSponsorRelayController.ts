import { useEffect, useMemo, useSyncExternalStore } from 'react'

import { createSponsorRelayController, type SponsorRelayProps } from '../../shared/index'

export function useSponsorRelayController(props: SponsorRelayProps) {
  const controller = useMemo(
    () => createSponsorRelayController(props),
    [
      props.apiHost,
      props.crnListUrl,
      props.instanceName,
      props.libp2p,
      props.manifestJson,
      props.manifestUrl,
      props.openByDefault,
      props.schedulerApiHost,
      props.showInstances,
      props.sshPublicKey,
      props.twoN6ApiHost
    ]
  )

  useEffect(() => {
    void controller.init()
    return () => {
      controller.destroy()
    }
  }, [controller])

  const state = useSyncExternalStore(
    (onStoreChange) => controller.subscribe(() => onStoreChange()),
    () => controller.getState(),
    () => controller.getState()
  )

  return { controller, state }
}
