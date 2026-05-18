import {
  broadcastAlephMessage,
  broadcastInstanceMessage,
  DEFAULT_ALEPH_API_HOST,
  DEFAULT_CRN_LIST_URL,
  fetchBalance,
  fetchCrns,
  fetchInstances,
  fetchMessageEnvelope,
  inspectDeploymentResult,
  waitForDeploymentResult
} from './aleph-api'
import type { AlephBrowserClient } from './types'

export interface CreateAlephBrowserClientOptions {
  apiHost?: string
  crnListUrl?: string
}

export function createAlephBrowserClient(options: CreateAlephBrowserClientOptions = {}): AlephBrowserClient {
  const apiHost = options.apiHost ?? DEFAULT_ALEPH_API_HOST
  const crnListUrl = options.crnListUrl ?? DEFAULT_CRN_LIST_URL

  return {
    apiHost,
    crnListUrl,
    fetchBalance(address) {
      return fetchBalance(address, apiHost)
    },
    fetchCrns() {
      return fetchCrns(crnListUrl)
    },
    fetchInstances(address) {
      return fetchInstances(address, apiHost)
    },
    fetchMessageEnvelope(itemHash) {
      return fetchMessageEnvelope(itemHash, apiHost)
    },
    inspectDeploymentResult(itemHash, rootfsRef) {
      return inspectDeploymentResult(itemHash, rootfsRef, apiHost)
    },
    waitForDeploymentResult(itemHash, rootfsRef, attempts, delayMs) {
      return waitForDeploymentResult(itemHash, rootfsRef, apiHost, attempts, delayMs)
    },
    broadcastInstanceMessage(message, sync) {
      return broadcastInstanceMessage(message, apiHost, sync)
    },
    broadcastAlephMessage(message, sync) {
      return broadcastAlephMessage(message, apiHost, sync)
    }
  }
}
