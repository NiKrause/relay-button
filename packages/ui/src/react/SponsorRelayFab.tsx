import React from 'react'

import { formatDateTime, formatNumber, joinMappedPorts, shortHash, type SponsorRelayProps } from '../shared/index'
import { useSponsorRelayController } from './hooks/useSponsorRelayController'

const panelStyle: React.CSSProperties = {
  position: 'fixed',
  right: '1.4rem',
  bottom: '11.5rem',
  zIndex: 9999,
  width: 'min(28rem, calc(100vw - 2rem))',
  maxHeight: 'calc(100vh - 12.5rem)',
  overflow: 'auto',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: '1.4rem',
  background: 'rgba(12,20,31,0.92)',
  color: '#f8fafc',
  boxShadow: '0 28px 80px rgba(3,8,20,0.45)',
  padding: '1rem',
  fontFamily: '"DM Sans", "Inter", sans-serif'
}

export function SponsorRelayFab(props: SponsorRelayProps) {
  const { controller, state } = useSponsorRelayController(props)
  const launcherMode = props.launcherMode ?? 'floating'

  return (
    <>
      <button
        type="button"
        onClick={() => controller.toggleOpen()}
        style={{
          position: launcherMode === 'floating' ? 'fixed' : 'relative',
          right: launcherMode === 'floating' ? '1.4rem' : undefined,
          bottom: launcherMode === 'floating' ? '5.8rem' : undefined,
          zIndex: launcherMode === 'floating' ? 10000 : 'auto',
          borderRadius: '999px',
          border: '2px solid rgba(255,255,255,0.9)',
          background: 'linear-gradient(135deg, #e91315 0%, #ffc83f 100%)',
          color: 'white',
          padding: launcherMode === 'floating' ? '0.9rem 1.2rem' : '0.55rem 0.9rem',
          fontFamily: '"Epilogue", sans-serif',
          fontWeight: 700,
          fontSize: launcherMode === 'floating' ? '0.84rem' : '0.78rem',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          cursor: 'pointer'
        }}
      >
        Sponsor Relay
      </button>

      {state.open ? (
        <div>
          <div
            onClick={() => controller.setOpen(false)}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 9998,
              background: 'radial-gradient(circle at 88% 82%, rgba(233,19,21,0.18), transparent 34%)'
            }}
          />
          <aside style={panelStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'center' }}>
              <div>
                <div style={{ color: '#9fb2ca', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  Aleph VM credit deployer
                </div>
                <h2 style={{ margin: '0.2rem 0 0', fontFamily: '"Epilogue", sans-serif' }}>Sponsor Relay</h2>
              </div>
              <button type="button" onClick={() => void controller.refresh()}>
                {state.busy.refreshing ? 'Syncing' : 'Refresh'}
              </button>
            </div>

            <p style={{ color: '#9fb2ca' }}>{state.statusText}</p>
            {state.errorText ? <p style={{ color: '#ffd9d9' }}>{state.errorText}</p> : null}

            <div style={{ display: 'grid', gap: '0.75rem', marginTop: '0.9rem' }}>
              <input value={state.manifestUrl} onChange={(event) => controller.setManifestUrl(event.currentTarget.value)} placeholder="Manifest URL" />
              <input value={state.instanceName} onChange={(event) => controller.setInstanceName(event.currentTarget.value)} placeholder="Instance name" />
              <select value={state.pricingSummary.tier?.id ?? state.tierId} onChange={(event) => controller.setTierId(event.currentTarget.value)}>
                {(state.pricingSummary.pricing?.tiers ?? []).map((tier) => (
                  <option key={tier.id} value={tier.id}>
                    {tier.id}
                  </option>
                ))}
              </select>
              <textarea rows={3} value={state.sshPublicKey} onChange={(event) => controller.setSshPublicKey(event.currentTarget.value)} placeholder="SSH public key" />
              <details>
                <summary>Paste Manifest</summary>
                <textarea rows={7} value={state.manifestJson} onChange={(event) => controller.setManifestJson(event.currentTarget.value)} />
              </details>
            </div>

            <div style={{ display: 'grid', gap: '0.55rem', marginTop: '1rem' }}>
              <div>{formatNumber(state.pricingSummary.availableCredits, 0)} credits available</div>
              <div>{formatNumber(state.pricingSummary.requiredCredits, 0)} credits required</div>
              <div>{state.rootfsHealth.label}</div>
              <div>{state.selectedCrn?.name ?? shortHash(state.selectedCrn?.hash)}</div>
            </div>

            <button
              type="button"
              onClick={() => void (state.wallet.connected ? controller.deploy() : controller.connectWallet())}
              style={{ width: '100%', marginTop: '1rem' }}
            >
              {state.wallet.connected ? (state.busy.deploying ? 'Deploying…' : 'Deploy Relay') : 'Connect MetaMask'}
            </button>

            {state.lastDeploymentHash ? <p>Latest deployment: {shortHash(state.lastDeploymentHash)}</p> : null}

            {state.showInstances ? (
              <div style={{ marginTop: '1rem', display: 'grid', gap: '0.7rem' }}>
                {state.instances.map((entry) => (
                  <details key={entry.instance.item_hash} open>
                    <summary>
                      {(entry.instance.content?.metadata?.name ?? 'relay') + ' · ' + shortHash(entry.instance.item_hash)}
                    </summary>
                    <div style={{ display: 'grid', gap: '0.35rem', marginTop: '0.55rem' }}>
                      <div>Status: {entry.details.messageStatus}</div>
                      <div>Host IPv4: {entry.details.hostIpv4 ?? '-'}</div>
                      <div>IPv6: {entry.details.ipv6 ?? '-'}</div>
                      <div>VM IPv4: {entry.details.vmIpv4 ?? '-'}</div>
                      <div>SSH: {entry.details.sshCommand ?? '-'}</div>
                      <div>Ports: {joinMappedPorts(entry.details.mappedPorts)}</div>
                      <div>Submitted: {formatDateTime(entry.instance.reception_time ?? entry.instance.time)}</div>
                      <button type="button" onClick={() => void controller.deleteInstance(entry.instance.item_hash)}>
                        {state.busy.deletingInstanceHash === entry.instance.item_hash ? 'Deleting…' : 'Delete'}
                      </button>
                    </div>
                  </details>
                ))}
              </div>
            ) : null}
          </aside>
        </div>
      ) : null}
    </>
  )
}

export default SponsorRelayFab
