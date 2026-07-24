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
export let apiHosts = undefined
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
  apiHosts,
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
    return deploymentProfile() === 'ucan-store' ? 'Service Button' : 'Relay Button'
  }

  function deploymentInstanceFallbackLabel() {
    return deploymentProfile() === 'ucan-store' ? 'service' : 'relay'
  }

  function deploymentButtonLabel() {
    return deploymentProfile() === 'ucan-store' ? 'Deploy Service' : 'Deploy Relay'
  }

  function deploymentCallToAction() {
    if (state.busy.deploying) return 'Deploying…'
    if (state.rootfsHealth.tone === 'error') return 'Deployment blocked — Rootfs unavailable'
    return deploymentButtonLabel()
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

    {#if state.rootfsHealth.tone === 'error'}
      <div class="rootfs-blocker" id="relay-rootfs-deployment-blocker" role="alert">
        <strong>Rootfs unavailable — deployment blocked</strong>
        <p>{state.rootfsHealth.detail}</p>
        <small>This is separate from the connected MetaMask balance. The manifest must reference an Aleph rootfs STORE with status <code>processed</code>.</small>
        {#if state.manifest?.rootfsItemHash}
          <code class="rootfs-reference">Rootfs: {state.manifest.rootfsItemHash}{state.rootfsResolution?.messageStatus ? ` · Aleph status: ${state.rootfsResolution.messageStatus}` : ''}</code>
        {/if}
        <div class="rootfs-actions">
          <button class="refresh" type="button" on:click={() => controller.refresh()} disabled={state.busy.refreshing}>{state.busy.refreshing ? 'Checking…' : 'Retry validation'}</button>
          <button class="refresh" type="button" on:click={() => controller.setShowAdvanced(true)}>Edit manifest URL</button>
          {#if /^https?:\/\//.test(state.manifestUrl)}
            <a href={state.manifestUrl} target="_blank" rel="noreferrer">Open manifest</a>
          {/if}
        </div>
      </div>
    {/if}

    <div class="actions">
      {#if state.wallet.connected}
        <button class:blocked={state.rootfsHealth.tone === 'error'} class="primary" type="button" aria-describedby={state.rootfsHealth.tone === 'error' ? 'relay-rootfs-deployment-blocker' : undefined} on:click={() => controller.deploy()} disabled={state.busy.deploying || state.rootfsHealth.tone !== 'ok'}>
          {deploymentCallToAction()}
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
    border-radius: 0.625rem;
    background: var(--relay-panel-bg);
    box-shadow: var(--relay-panel-shadow);
    color: var(--relay-text);
    padding: 1rem;
    font-family: var(--relay-font-body);
    font-size: 0.8125rem;
    line-height: 1.5;
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
    border-radius: 0.625rem;
    background: rgba(88, 199, 243, 0.08);
    border: 1px solid rgba(88, 199, 243, 0.22);
  }

  .polling-head {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
  }

  .polling-row strong {
    font-size: 0.8125rem;
  }

  .polling-row small {
    color: var(--relay-muted);
    line-height: 1.4;
  }

  .rootfs-blocker {
    display: grid;
    gap: 0.55rem;
    margin-top: 1rem;
    padding: 0.9rem;
    border: 1px solid rgba(255, 77, 106, 0.5);
    border-radius: 0.625rem;
    background: rgba(255, 77, 106, 0.1);
    color: var(--relay-text);
  }

  .rootfs-blocker strong {
    color: var(--relay-danger);
  }

  .rootfs-blocker p,
  .rootfs-blocker small { margin: 0; line-height: 1.45; }
  .rootfs-reference { overflow-wrap: anywhere; font-size: 0.6875rem; font-family: var(--relay-font-mono); }
  .rootfs-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  .rootfs-actions .refresh { padding: 0.5rem 0.7rem; }
  .rootfs-actions a { color: var(--relay-link); font-size: 0.75rem; }

  .primary.blocked {
    border-color: rgba(255, 77, 106, 0.45);
    background: var(--relay-surface);
    color: var(--relay-muted);
    box-shadow: none;
    cursor: not-allowed;
  }

  .eyebrow,
  .field span,
  .metric-card span,
  .mono-block span,
  .instance-grid span,
  .section-head small {
    color: var(--relay-comet);
    font-family: var(--relay-font-mono);
    font-weight: 700;
    font-size: 0.6563rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .eyebrow {
    color: var(--relay-accent);
  }

  .eyebrow-version {
    font-family: var(--relay-font-mono);
    font-weight: 400;
    font-size: 0.625rem;
    letter-spacing: 0.04em;
    text-transform: none;
    color: var(--relay-comet);
  }

  h2,
  h3,
  strong {
    margin: 0;
    font-family: var(--relay-font-heading);
  }

  h2 {
    font-size: 1.125rem;
    font-weight: 700;
    letter-spacing: -0.01em;
    color: var(--relay-text);
  }

  h3 {
    font-size: 0.9375rem;
    font-weight: 600;
  }

  .refresh,
  .primary,
  .delete,
  .warning {
    border-radius: 0.5rem;
    padding: 0.65rem 0.9rem;
    cursor: pointer;
    font-family: var(--relay-font-body);
    font-size: 0.8125rem;
    font-weight: 600;
    line-height: 1.1;
    transition: filter 150ms ease, border-color 150ms ease;
  }

  .refresh {
    border: 1px solid var(--relay-surface-border);
    color: var(--relay-text);
    background: var(--relay-surface);
  }

  .refresh:hover:not(:disabled) {
    border-color: var(--relay-cyan);
  }

  .primary {
    width: 100%;
    border: 1px solid transparent;
    background: var(--relay-accent);
    color: var(--relay-accent-contrast);
    font-weight: 700;
    box-shadow: 0 10px 24px rgba(255, 107, 91, 0.22);
  }

  .primary:hover:not(:disabled) {
    filter: brightness(1.06);
  }

  .delete {
    border: 1px solid rgba(255, 77, 106, 0.45);
    background: transparent;
    color: var(--relay-danger);
  }

  .warning {
    border: 1px solid rgba(255, 194, 75, 0.45);
    background: transparent;
    color: var(--relay-warning);
  }

  .chip-confirmed {
    border-color: rgba(62, 220, 151, 0.45);
    color: var(--relay-success);
    display: inline-flex;
    align-items: center;
    gap: 0.32rem;
  }

  .chip-dot-confirmed {
    width: 0.42rem;
    height: 0.42rem;
    border-radius: 999px;
    background: var(--relay-success);
    box-shadow: 0 0 0 3px rgba(62, 220, 151, 0.18);
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
    border: 1px solid var(--relay-surface-border);
    border-radius: 0.625rem;
    padding: 0.8rem;
    background: var(--relay-surface);
  }

  .status-pill {
    grid-template-columns: auto 1fr;
    align-items: center;
    gap: 0.7rem;
  }

  .status-pill strong,
  .metric-card strong {
    font-size: 0.8125rem;
  }

  .status-pill small,
  .metric-card small {
    color: var(--relay-muted);
    font-size: 0.6875rem;
    line-height: 1.4;
  }

  .orphan-box {
    display: grid;
    gap: 0.7rem;
    padding: 0.85rem;
    border-radius: 0.625rem;
    border: 1px solid rgba(255, 77, 106, 0.3);
    background: rgba(255, 77, 106, 0.06);
  }

  .orphan-head {
    display: grid;
    gap: 0.2rem;
  }

  .orphan-head strong {
    color: var(--relay-danger);
  }

  .orphan-head small {
    color: var(--relay-muted);
    line-height: 1.4;
  }

  .orphan-card {
    display: grid;
    gap: 0.35rem;
    padding: 0.75rem;
    border-radius: 0.5rem;
    background: var(--relay-surface);
    border: 1px solid var(--relay-surface-border);
    font-size: 0.75rem;
  }

  .orphan-title {
    font-weight: 700;
  }

  .alert {
    margin: 0.8rem 0 0;
    padding: 0.75rem 0.85rem;
    border-radius: 0.5rem;
    border: 1px solid rgba(255, 77, 106, 0.3);
    background: rgba(255, 77, 106, 0.1);
    color: var(--relay-danger);
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
    font-size: 0.6875rem;
    line-height: 1.4;
  }

  .field.wide {
    grid-column: 1 / -1;
  }

  .accordion {
    margin-top: 0.9rem;
    border: 1px solid var(--relay-surface-border);
    border-radius: 0.625rem;
    background: var(--relay-surface);
  }

  .accordion summary {
    cursor: pointer;
    list-style: none;
    padding: 0.75rem 0.9rem;
    color: var(--relay-text);
    font: 700 0.6875rem/1.1 var(--relay-font-mono);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .accordion summary::-webkit-details-marker {
    display: none;
  }

  .accordion-body {
    padding: 0 0.9rem 0.9rem;
  }

  .advanced-grid {
    display: grid;
    gap: 0.75rem;
  }

  input,
  select,
  textarea {
    width: 100%;
    border: 1px solid var(--relay-surface-border);
    border-radius: 0.5rem;
    background: var(--relay-field-bg);
    color: var(--relay-text);
    padding: 0.65rem 0.8rem;
    font: 500 0.8125rem/1.4 var(--relay-font-body);
  }

  input:focus-visible,
  select:focus-visible,
  textarea:focus-visible {
    outline: 2px solid var(--relay-cyan);
    outline-offset: 1px;
  }

  textarea,
  .mono-block strong {
    font-family: var(--relay-font-mono);
  }

  .mono-block strong {
    font-size: 0.75rem;
    overflow-wrap: anywhere;
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

  .deployment-box strong {
    font-family: var(--relay-font-mono);
    font-size: 0.75rem;
  }

  .instance-grid {
    grid-template-columns: 1fr 1fr;
    margin: 0.75rem 0;
  }

  .instance-grid strong {
    font-size: 0.8125rem;
    overflow-wrap: anywhere;
  }

  .chip-row {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .chip {
    border: 1px solid var(--relay-surface-border);
    border-radius: 999px;
    padding: 0.22rem 0.55rem;
    background: transparent;
    color: var(--relay-muted);
    font-family: var(--relay-font-mono);
    font-weight: 700;
    font-size: 0.6563rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .link-row {
    justify-content: flex-start;
    flex-wrap: wrap;
    margin-top: 0.7rem;
  }

  .link-row a {
    color: var(--relay-link);
    text-decoration: none;
    font-weight: 600;
    font-size: 0.8125rem;
  }

  .link-row a:hover {
    text-decoration: underline;
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
