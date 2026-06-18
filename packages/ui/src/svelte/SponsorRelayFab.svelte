<script>
  import { onDestroy, onMount } from 'svelte'

  import { UI_PACKAGE_VERSION, createSponsorRelayController, formatDateTime, formatNumber, formatTierSpecLabel, joinMappedPorts, joinRequiredPortForwards, shortHash } from '../shared/index'
  import AccordionSection from './components/AccordionSection.svelte'
  import CopyButton from './components/CopyButton.svelte'
  import LauncherButton from './components/LauncherButton.svelte'
  import StatusLed from './components/StatusLed.svelte'
  import './styles/theme.css'

  export let manifestUrl = './rootfs-manifest.json'
export let manifestJson = ''
export let sshPublicKey = ''
export let instanceName = 'sponsor-relay'
  export let ucanStoreBootstrap = undefined
export let showInstances = true
export let openByDefault = false
export let launcherMode = 'floating'
export let version = ''
export let apiHost = undefined
  export let crnListUrl = undefined
  export let schedulerApiHost = undefined
  export let twoN6ApiHost = undefined

  const controller = createSponsorRelayController({
    manifestUrl,
    manifestJson,
    sshPublicKey,
    instanceName,
    ucanStoreBootstrap,
    showInstances,
  openByDefault,
  launcherMode,
  apiHost,
    crnListUrl,
    schedulerApiHost,
    twoN6ApiHost
  })

  let state = controller.getState()
  const resolvedVersion = version.trim() || UI_PACKAGE_VERSION
  const versionLabel = resolvedVersion.trim()
    ? (resolvedVersion.trim().startsWith('v') ? resolvedVersion.trim() : `v${resolvedVersion.trim()}`)
    : ''
  const pollingStages = new Set(['waiting-for-aleph', 'deployment-confirmed', 'publishing-bootstrap', 'refreshing-instances'])

  function deploymentProfile() {
    return state.manifest?.profile === 'ucan-store' ? 'ucan-store' : 'relay'
  }

  function deploymentTitle() {
    return deploymentProfile() === 'ucan-store' ? 'Sponsor Service' : 'Sponsor Relay'
  }

  function deploymentInstanceFallbackLabel() {
    return deploymentProfile() === 'ucan-store' ? 'service' : 'relay'
  }

  function deploymentButtonLabel() {
    return deploymentProfile() === 'ucan-store' ? 'Deploy Service' : 'Deploy Relay'
  }

  function bootstrapUiEnabled() {
    return deploymentProfile() !== 'ucan-store'
  }

  $: pollingActive = state.busy.refreshing || pollingStages.has(state.deploymentProgress.stage)
  $: isServiceProfile = deploymentProfile() === 'ucan-store'
  $: pollingLabel = state.busy.refreshing
    ? (isServiceProfile ? 'Checking deployment state' : 'Checking relay state')
    : (state.deploymentProgress.label || (isServiceProfile ? 'Polling deployment state' : 'Polling relay state'))
  $: pollingDetail = state.busy.refreshing
    ? (state.statusText || (isServiceProfile
      ? 'Refreshing service deployment data from Aleph and the selected CRN.'
      : 'Refreshing relay deployment data from Aleph and the selected CRN.'))
    : (state.deploymentProgress.detail || state.statusText || (isServiceProfile
      ? 'Waiting for the next confirmed deployment state from Aleph.'
      : 'Waiting for the next confirmed relay state from Aleph.'))
  $: confirmedRegistrationByInstanceHash = new Map(
    (state.bootstrapRegistrations ?? [])
      .filter((entry) => entry.confirmed && entry.instanceItemHash)
      .map((entry) => [entry.instanceItemHash, entry]),
  )
  $: orphanRegistrations = state.orphanBootstrapRegistrations ?? []

  onMount(async () => {
    const unsubscribe = controller.subscribe((next) => {
      state = next
    })

    await controller.init()
    return unsubscribe
  })

  onDestroy(() => {
    controller.destroy()
  })
</script>

<LauncherButton open={state.open} onToggle={() => controller.toggleOpen()} mode={launcherMode} />

{#if state.open}
  <div class="backdrop" on:click={() => controller.setOpen(false)}></div>
{/if}

{#if state.open}
  <aside class="panel">
    <div class="panel-head">
      <div>
        <p class="eyebrow">
          Aleph VM credit deployer
          {#if versionLabel}
            <span class="eyebrow-version">{versionLabel}</span>
          {/if}
        </p>
        <h2>{deploymentTitle()}</h2>
      </div>
      <button class="refresh" type="button" on:click={() => controller.refresh()} disabled={state.busy.refreshing}>
        {state.busy.refreshing ? 'Syncing' : 'Refresh'}
      </button>
    </div>

    <div class="status-strip">
      <div class="status-pill">
        <StatusLed tone={state.wallet.connected ? 'ok' : 'error'} />
        <div>
          <strong>{state.wallet.connected ? shortHash(state.wallet.address, 6, 4) : 'MetaMask disconnected'}</strong>
          <small>{state.wallet.connected ? 'Credit-only wallet active' : 'Connect wallet to continue'}</small>
        </div>
      </div>
      <div class="status-pill">
        <StatusLed tone={state.rootfsHealth.tone} />
        <div>
          <strong>{state.rootfsHealth.label}</strong>
          <small>{state.rootfsHealth.detail ?? 'No rootfs details yet'}</small>
        </div>
      </div>
    </div>

    {#if state.errorText}
      <p class="alert error">{state.errorText}</p>
    {/if}
    <p class="status-text">{state.statusText}</p>

    {#if pollingActive}
      <div class="polling-row" aria-live="polite">
        <div class="polling-head">
          <StatusLed tone="idle" pulse={true} />
          <strong>{pollingLabel}</strong>
        </div>
        <small>{pollingDetail}</small>
      </div>
    {/if}

    <div class="grid">
      <label class="field">
        <span>Instance Name</span>
        <input value={state.instanceName} on:input={(event) => controller.setInstanceName(event.currentTarget.value)} />
      </label>
      <label class="field">
        <span>Tier</span>
        <select value={state.pricingSummary.tier?.id ?? state.tierId} on:change={(event) => controller.setTierId(event.currentTarget.value)}>
          {#each (state.pricingSummary.pricing?.tiers?.length ? state.pricingSummary.pricing.tiers : [{ id: state.tierId, compute_units: 1 }]) as tier}
            <option value={tier.id}>
              {tier.id} {formatTierSpecLabel(
                state.pricingSummary.pricing ? state.pricingSummary.pricing.compute_unit.vcpus * tier.compute_units : null,
                state.pricingSummary.pricing ? state.pricingSummary.pricing.compute_unit.memory_mib * tier.compute_units : null,
                state.pricingSummary.pricing ? state.pricingSummary.pricing.compute_unit.disk_mib * tier.compute_units : null
              )}
            </option>
          {/each}
        </select>
        <small>{formatTierSpecLabel(state.pricingSummary.vcpus, state.pricingSummary.memoryMiB, state.pricingSummary.diskMiB)}</small>
      </label>
    </div>

    <details class="accordion" open={state.showAdvanced} on:toggle={(event) => controller.setShowAdvanced(event.currentTarget.open)}>
      <summary>Advanced</summary>
      <div class="accordion-body advanced-grid">
        <label class="field wide">
          <span>Manifest URL</span>
          <input value={state.manifestUrl} on:input={(event) => controller.setManifestUrl(event.currentTarget.value)} />
        </label>
        <label class="field wide">
          <span>SSH Public Key</span>
          <textarea rows="3" on:input={(event) => controller.setSshPublicKey(event.currentTarget.value)}>{state.sshPublicKey}</textarea>
        </label>

        <AccordionSection title="Paste Manifest" open={state.showPasteManifest}>
          <label class="field wide">
            <span>Pasted rootfs manifest JSON</span>
            <textarea rows="7" on:input={(event) => controller.setManifestJson(event.currentTarget.value)}>{state.manifestJson}</textarea>
          </label>
        </AccordionSection>

        {#if deploymentProfile() === 'ucan-store'}
          <AccordionSection title="UCAN Store Bootstrap" open={true}>
            <label class="field wide">
              <span>Admin DID</span>
              <input value={state.ucanStoreBootstrap.adminDid} on:input={(event) => controller.setUcanStoreBootstrapField('adminDid', event.currentTarget.value)} />
            </label>
            <label class="field wide">
              <span>Service DID Override</span>
              <input value={state.ucanStoreBootstrap.serviceDid} on:input={(event) => controller.setUcanStoreBootstrapField('serviceDid', event.currentTarget.value)} />
            </label>
            <label class="field wide">
              <span>Space DID</span>
              <input value={state.ucanStoreBootstrap.spaceDid} on:input={(event) => controller.setUcanStoreBootstrapField('spaceDid', event.currentTarget.value)} />
            </label>
            <label class="field wide">
              <span>Root Delegation Proof</span>
              <textarea rows="5" on:input={(event) => controller.setUcanStoreBootstrapField('rootDelegationProof', event.currentTarget.value)}>{state.ucanStoreBootstrap.rootDelegationProof}</textarea>
            </label>
            <label class="field wide">
              <span>Allowed Capabilities</span>
              <textarea rows="4" on:input={(event) => controller.setUcanStoreBootstrapField('allowedCapabilities', event.currentTarget.value)}>{state.ucanStoreBootstrap.allowedCapabilities}</textarea>
            </label>
            <div class="grid">
              <label class="field">
                <span>Default Expiration</span>
                <input value={state.ucanStoreBootstrap.defaultUserDelegationExpiration} on:input={(event) => controller.setUcanStoreBootstrapField('defaultUserDelegationExpiration', event.currentTarget.value)} />
              </label>
              <label class="field">
                <span>Max Expiration</span>
                <input value={state.ucanStoreBootstrap.maxUserDelegationExpiration} on:input={(event) => controller.setUcanStoreBootstrapField('maxUserDelegationExpiration', event.currentTarget.value)} />
              </label>
            </div>
            <label class="field wide">
              <span>PWA Origin Override</span>
              <input value={state.ucanStoreBootstrap.pwaOrigin} on:input={(event) => controller.setUcanStoreBootstrapField('pwaOrigin', event.currentTarget.value)} />
            </label>
            <label class="field wide">
              <span>Service Origin Override</span>
              <input value={state.ucanStoreBootstrap.serviceOrigin} on:input={(event) => controller.setUcanStoreBootstrapField('serviceOrigin', event.currentTarget.value)} />
            </label>
            <small>Operator address comes from the connected MetaMask account. If service origin is empty, the runtime proxy URL is used during guest configuration.</small>
          </AccordionSection>
        {/if}
      </div>
    </details>

    <div class="metrics">
      <div class="metric-card">
        <span>Credits</span>
        <strong>{formatNumber(state.pricingSummary.availableCredits, 0)} available</strong>
        <small>{formatNumber(state.pricingSummary.requiredCredits, 0)} required</small>
      </div>
      <div class="metric-card">
        <span>Tier spec</span>
        <strong>{formatNumber(state.pricingSummary.vcpus, 0)} vCPU · {formatNumber(state.pricingSummary.memoryMiB, 0)} MiB</strong>
        <small>{formatNumber(state.pricingSummary.diskMiB, 0)} MiB disk</small>
      </div>
      <div class="metric-card">
        <span>CRN</span>
        <strong>{state.selectedCrn?.name ?? shortHash(state.selectedCrn?.hash)}</strong>
        <small>{state.selectedCrn?.address ?? 'Auto-picked best compatible CRN'}</small>
      </div>
      <div class="metric-card">
        <span>Required ports</span>
        <strong>{joinRequiredPortForwards(state.manifest?.requiredPortForwards ?? [])}</strong>
        <small>Derived from the active rootfs manifest</small>
      </div>
    </div>

    <div class="actions">
      {#if state.wallet.connected}
        <button class="primary" type="button" on:click={() => controller.deploy()} disabled={state.busy.deploying || state.rootfsHealth.tone !== 'ok'}>
          {state.busy.deploying ? 'Deploying…' : deploymentButtonLabel()}
        </button>
      {:else}
        <button class="primary" type="button" on:click={() => controller.connectWallet()} disabled={state.busy.connectingWallet}>
          {state.busy.connectingWallet ? 'Connecting…' : 'Connect MetaMask'}
        </button>
      {/if}
    </div>

    {#if state.lastDeploymentHash}
      <div class="deployment-box">
        <span>Latest deployment</span>
        <strong>{shortHash(state.lastDeploymentHash)}</strong>
        <CopyButton text={state.lastDeploymentHash} label="Copy hash" />
      </div>
    {/if}

    {#if state.showInstances}
      <section class="instances">
        <div class="section-head">
          <div>
            <h3>Instances</h3>
            <small>{state.instances.length} deployment{state.instances.length === 1 ? '' : 's'}</small>
          </div>
        </div>

        {#if state.instances.length === 0}
          <p class="empty">Connect a wallet to load current deployments.</p>
        {/if}

        {#each state.instances as entry}
          <AccordionSection title={`${entry.instance.content?.metadata?.name ?? deploymentInstanceFallbackLabel()} · ${shortHash(entry.instance.item_hash)}`} open={true}>
            {@const confirmedRegistration = confirmedRegistrationByInstanceHash.get(entry.instance.item_hash)}
            <div class="instance-topline">
              <div class="chip-row">
                <span class="chip">{entry.details.messageStatus}</span>
                {#if entry.details.crnUrl}
                  <span class="chip">{entry.details.crnUrl.replace(/^https?:\/\//, '')}</span>
                {/if}
                {#if bootstrapUiEnabled() && confirmedRegistration}
                  <span class="chip chip-confirmed">
                    <span class="chip-dot-confirmed"></span>
                    Aleph bootstrap registered
                  </span>
                {/if}
              </div>
              <button
                class="delete"
                type="button"
                disabled={state.busy.deletingInstanceHash === entry.instance.item_hash}
                on:click={() => controller.deleteInstance(entry.instance.item_hash)}
              >
                {state.busy.deletingInstanceHash === entry.instance.item_hash ? 'Deleting…' : 'Delete'}
              </button>
            </div>

            <div class="instance-grid">
              <div>
                <span>Host IPv4</span>
                <strong>{entry.details.hostIpv4 ?? '-'}</strong>
              </div>
              <div>
                <span>IPv6</span>
                <strong>{entry.details.ipv6 ?? '-'}</strong>
              </div>
              <div>
                <span>VM IPv4</span>
                <strong>{entry.details.vmIpv4 ?? '-'}</strong>
              </div>
              <div>
                <span>Submitted</span>
                <strong>{formatDateTime(entry.instance.reception_time ?? entry.instance.time)}</strong>
              </div>
            </div>

            <div class="mono-block">
              <span>SSH</span>
              <strong>{entry.details.sshCommand ?? '-'}</strong>
              <CopyButton text={entry.details.sshCommand ?? ''} />
            </div>

            <div class="mono-block">
              <span>Mapped ports</span>
              <strong>{joinMappedPorts(entry.details.mappedPorts)}</strong>
            </div>

            {#if bootstrapUiEnabled() && confirmedRegistration}
              <div class="mono-block">
                <span>Bootstrap Registration</span>
                <strong>{shortHash(confirmedRegistration.messageHash ?? confirmedRegistration.content?.registrationId ?? 'confirmed', 14, 8)}</strong>
              </div>
            {/if}

            <div class="link-row">
              <CopyButton text={entry.instance.item_hash} label="Copy hash" />
              {#if entry.details.webUrl}
                <a href={entry.details.webUrl} target="_blank" rel="noreferrer">Web</a>
              {/if}
              <a href={`https://api.aleph.im/api/v0/messages/${entry.instance.item_hash}`} target="_blank" rel="noreferrer">API</a>
              <a href={`https://explorer.aleph.cloud/address/ETH/${entry.instance.sender}/message/INSTANCE/${entry.instance.item_hash}`} target="_blank" rel="noreferrer">Explorer</a>
            </div>

            {#if entry.details.error}
              <p class="alert error">{entry.details.error}</p>
            {/if}
          </AccordionSection>
        {/each}

        {#if bootstrapUiEnabled() && orphanRegistrations.length > 0}
          <div class="orphan-box">
            <div class="orphan-head">
              <strong>Orphan bootstrap registrations</strong>
              <small>Current-wallet registrations without a matching instance. Forget them directly from here.</small>
            </div>

            {#each orphanRegistrations as entry}
              {@const registrationHash = entry.messageHash ?? entry.hash}
              <div class="orphan-card">
                <div class="orphan-title">{entry.content?.registrationId ?? 'registration'} · {shortHash(registrationHash ?? 'unknown')}</div>
                <div>Peer: {entry.content?.peerId ?? '-'}</div>
                <div>Linked instance: {entry.instanceItemHash ? shortHash(entry.instanceItemHash) : 'missing'}</div>
                <div>Browser multiaddrs: {String(entry.content?.browserMultiaddrs?.length ?? 0)}</div>
                <div>Updated: {formatDateTime(entry.content?.updatedAt ?? entry.time)}</div>
                <button
                  class="warning"
                  type="button"
                  disabled={!registrationHash || state.busy.deletingRegistrationHash === registrationHash}
                  on:click={() => registrationHash && controller.deleteBootstrapRegistration(registrationHash)}
                >
                  {state.busy.deletingRegistrationHash === registrationHash ? 'Forgetting…' : 'Forget registration'}
                </button>
              </div>
            {/each}
          </div>
        {/if}
      </section>
    {/if}
  </aside>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 9998;
    background: radial-gradient(circle at 88% 82%, var(--relay-backdrop-accent), transparent 34%);
    backdrop-filter: blur(2px);
  }

  .panel {
    position: fixed;
    right: 1.4rem;
    bottom: 11.5rem;
    z-index: 9999;
    width: min(28rem, calc(100vw - 2rem));
    max-height: calc(100vh - 12.5rem);
    overflow: auto;
    border: 1px solid var(--relay-panel-border);
    border-radius: 1.6rem;
    background: var(--relay-panel-bg);
    box-shadow: var(--relay-panel-shadow);
    color: var(--relay-text);
    padding: 1rem;
    font-family: var(--relay-font-body);
  }

  .panel-head,
  .status-strip,
  .actions,
  .section-head,
  .instance-topline,
  .link-row {
    display: flex;
    gap: 0.8rem;
    align-items: center;
    justify-content: space-between;
  }

  .polling-row {
    display: grid;
    gap: 0.28rem;
    margin: 0.25rem 0 0.8rem;
    padding: 0.7rem 0.85rem;
    border-radius: 1rem;
    background: linear-gradient(180deg, rgba(59, 130, 246, 0.12), rgba(59, 130, 246, 0.05));
    border: 1px solid rgba(125, 211, 252, 0.18);
  }

  .polling-head {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
  }

  .polling-row strong {
    font-size: 0.88rem;
  }

  .polling-row small {
    color: var(--relay-text-dim);
    line-height: 1.35;
  }

  .eyebrow,
  .field span,
  .metric-card span,
  .mono-block span,
  .instance-grid span,
  .section-head small {
    color: var(--relay-muted);
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .eyebrow-version {
    font-size: 0.62rem;
    letter-spacing: 0.04em;
    text-transform: none;
    color: rgba(191, 219, 254, 0.82);
  }

  h2,
  h3,
  strong {
    margin: 0;
    font-family: var(--relay-font-heading);
  }

  h2 {
    font-size: 1.5rem;
  }

  .refresh,
  .primary,
  .delete,
  .warning {
    border-radius: 0.95rem;
    padding: 0.7rem 0.9rem;
    cursor: pointer;
    font-weight: 700;
    line-height: 1.1;
  }

  .refresh {
    border: 1px solid rgba(255, 255, 255, 0.22);
    color: var(--relay-text);
    background: rgba(255, 255, 255, 0.1);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
    backdrop-filter: blur(8px);
  }

  .primary {
    width: 100%;
    border: 1px solid rgba(251, 191, 36, 0.42);
    background: linear-gradient(135deg, #f6c453 0%, #f59e0b 100%);
    color: #281606;
    box-shadow: 0 10px 24px rgba(245, 158, 11, 0.24);
  }

  .delete {
    border: 1px solid rgba(248, 113, 113, 0.45);
    background: rgba(239, 68, 68, 0.18);
    color: #ffe2e2;
  }

  .warning {
    border: 1px solid rgba(251, 146, 60, 0.4);
    background: rgba(251, 146, 60, 0.16);
    color: #fed7aa;
  }

  .chip-confirmed {
    background: rgba(34, 197, 94, 0.16);
    color: #86efac;
    display: inline-flex;
    align-items: center;
    gap: 0.32rem;
  }

  .chip-dot-confirmed {
    width: 0.45rem;
    height: 0.45rem;
    border-radius: 999px;
    background: #22c55e;
    box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.18);
  }

  .status-strip,
  .metrics {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
    margin-top: 0.95rem;
  }

  .status-pill,
  .metric-card {
    display: grid;
    gap: 0.3rem;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 1rem;
    padding: 0.8rem;
    background: rgba(255, 255, 255, 0.035);
  }

  .status-pill {
    grid-template-columns: auto 1fr;
    align-items: center;
    gap: 0.7rem;
  }

  .orphan-box {
    display: grid;
    gap: 0.7rem;
    padding: 0.85rem;
    border-radius: 1rem;
    border: 1px solid rgba(248, 113, 113, 0.22);
    background: linear-gradient(180deg, rgba(127, 29, 29, 0.18), rgba(69, 10, 10, 0.12));
  }

  .orphan-head {
    display: grid;
    gap: 0.2rem;
  }

  .orphan-head small {
    color: #fecaca;
    line-height: 1.35;
  }

  .orphan-card {
    display: grid;
    gap: 0.35rem;
    padding: 0.75rem;
    border-radius: 0.9rem;
    background: rgba(15, 23, 42, 0.22);
    border: 1px solid rgba(255, 255, 255, 0.08);
  }

  .orphan-title {
    font-weight: 700;
  }

  .alert {
    margin: 0.8rem 0 0;
    padding: 0.75rem 0.85rem;
    border-radius: 0.9rem;
    background: rgba(233, 19, 21, 0.12);
    color: #ffd9d9;
  }

  .status-text {
    color: var(--relay-muted);
    margin: 0.65rem 0 0;
  }

  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
    margin-top: 1rem;
  }

  .field {
    display: grid;
    gap: 0.4rem;
  }

  .field small {
    color: var(--relay-muted);
    font-size: 0.72rem;
    line-height: 1.35;
  }

  .field.wide {
    grid-column: 1 / -1;
  }

  .accordion {
    margin-top: 0.9rem;
    border: 1px solid var(--relay-panel-border);
    border-radius: 1rem;
    background: rgba(255, 255, 255, 0.035);
  }

  .accordion summary {
    cursor: pointer;
    list-style: none;
    padding: 0.8rem 0.95rem;
    color: var(--relay-text);
    font: 700 0.8rem/1.1 var(--relay-font-heading);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .accordion summary::-webkit-details-marker {
    display: none;
  }

  .accordion-body {
    padding: 0 0.95rem 0.95rem;
  }

  .advanced-grid {
    display: grid;
    gap: 0.75rem;
  }

  input,
  select,
  textarea {
    width: 100%;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 0.95rem;
    background: rgba(255, 255, 255, 0.05);
    color: var(--relay-text);
    padding: 0.75rem 0.85rem;
    font: 500 0.9rem/1.35 var(--relay-font-body);
  }

  textarea,
  .mono-block strong {
    font-family: var(--relay-font-mono);
  }

  .actions,
  .deployment-box,
  .instances {
    margin-top: 1rem;
  }

  .deployment-box,
  .mono-block,
  .instance-grid {
    display: grid;
    gap: 0.3rem;
  }

  .instance-grid {
    grid-template-columns: 1fr 1fr;
    margin: 0.75rem 0;
  }

  .chip-row {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .chip {
    border-radius: 999px;
    padding: 0.25rem 0.55rem;
    background: rgba(255, 255, 255, 0.08);
    color: var(--relay-text);
    font-size: 0.72rem;
  }

  .link-row {
    justify-content: flex-start;
    flex-wrap: wrap;
    margin-top: 0.7rem;
  }

  .link-row a {
    color: #bde0ff;
    text-decoration: none;
    font-weight: 700;
  }

  .empty {
    color: var(--relay-muted);
  }

  button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  @media (max-width: 640px) {
    .panel {
      right: 0.8rem;
      left: 0.8rem;
      width: auto;
      bottom: 7.4rem;
      max-height: calc(100vh - 8.4rem);
    }

    .grid,
    .metrics,
    .status-strip,
    .instance-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
