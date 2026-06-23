import { useEffect, useMemo, useSyncExternalStore } from 'react'

import { createSponsorRelayController, type SponsorRelayProps } from '../../shared/index'

export function useSponsorRelayController(props: SponsorRelayProps) {
  const controller = useMemo(
    () => createSponsorRelayController(props),
    [
      props.apiHost,
      props.apiHosts,
      props.crnListUrl,
      props.debug,
      props.instanceName,
      props.manifestJson,
      props.manifestUrl,
      props.openByDefault,
      props.schedulerApiHost,
      props.showInstances,
      props.sshPublicKey,
      props.twoN6ApiHost,
      props.ucanStoreBootstrap
    ]
  )

  useEffect(() => {
    controller.updateProps({
      debug: props.debug
    })
  }, [controller, props.debug])

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
