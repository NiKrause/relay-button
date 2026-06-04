<script>
  import { onDestroy, onMount } from 'svelte'

  import { createSponsorRelayController, formatDateTime, formatNumber, formatTierSpecLabel, joinMappedPorts, joinRequiredPortForwards, shortHash } from '../shared/index'
  import AccordionSection from './components/AccordionSection.svelte'
  import CopyButton from './components/CopyButton.svelte'
  import LauncherButton from './components/LauncherButton.svelte'
  import StatusLed from './components/StatusLed.svelte'
  import './styles/theme.css'

  export let libp2p = null
  export let manifestUrl = './rootfs-manifest.json'
  export let manifestJson = ''
  export let sshPublicKey = ''
export let instanceName = 'sponsor-relay'
export let showInstances = true
export let openByDefault = false
export let launcherMode = 'floating'
export let apiHost = undefined
  export let crnListUrl = undefined
  export let schedulerApiHost = undefined
  export let twoN6ApiHost = undefined

  const controller = createSponsorRelayController({
    libp2p,
    manifestUrl,
    manifestJson,
    sshPublicKey,
    instanceName,
    showInstances,
  openByDefault,
  launcherMode,
  apiHost,
    crnListUrl,
    schedulerApiHost,
    twoN6ApiHost
  })

  let state = controller.getState()

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
        <p class="eyebrow">Aleph VM credit deployer</p>
        <h2>Sponsor Relay</h2>
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

    <div class="ping-strip">
      <div>
        <span class="mini-label">relay ping sent</span>
        <div class="mini-row"><StatusLed tone={state.relayPing.sent ? 'caution' : state.relayPing.tone} pulse={state.relayPing.sent} /><strong>{state.relayPing.sent ? 'sent' : 'idle'}</strong></div>
      </div>
      <div>
        <span class="mini-label">relay pong received</span>
        <div class="mini-row"><StatusLed tone={state.relayPing.received ? 'ok' : state.relayPing.tone} pulse={state.relayPing.received} /><strong>{state.relayPing.received ? `${formatNumber(state.relayPing.lastLatencyMs, 0)} ms` : 'waiting'}</strong></div>
      </div>
    </div>

    {#if state.errorText}
      <p class="alert error">{state.errorText}</p>
    {/if}
    <p class="status-text">{state.statusText}</p>

    <div class="grid">
      <label class="field">
        <span>Instance Name</span>
        <input value={state.instanceName} on:input={(event) => controller.setInstanceName(event.currentTarget.value)} />
      </label>
      <label class="field">
        <span>Tier</span>
        <select value={state.pricingSummary.tier?.id ?? state.tierId} on:change={(event) => controller.setTierId(event.currentTarget.value)}>
          {#each state.pricingSummary.pricing?.tiers ?? [] as tier}
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
        <button class="primary" type="button" on:click={() => controller.deploy()} disabled={state.busy.deploying || !state.rootfsVerified}>
          {state.busy.deploying ? 'Deploying…' : 'Deploy Relay'}
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
          <AccordionSection title={`${entry.instance.content?.metadata?.name ?? 'relay'} · ${shortHash(entry.instance.item_hash)}`} open={true}>
            <div class="instance-topline">
              <div class="chip-row">
                <span class="chip">{entry.details.messageStatus}</span>
                {#if entry.details.crnUrl}
                  <span class="chip">{entry.details.crnUrl.replace(/^https?:\/\//, '')}</span>
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

            <div class="link-row">
              <CopyButton text={entry.instance.item_hash} label="Copy hash" />
              {#if entry.details.webUrl}
                <a href={entry.details.webUrl} target="_blank" rel="noreferrer">Web</a>
              {/if}
              <a href={`https://api2.aleph.im/api/v0/messages/${entry.instance.item_hash}`} target="_blank" rel="noreferrer">API</a>
              <a href={`https://explorer.aleph.cloud/address/ETH/${entry.instance.sender}/message/INSTANCE/${entry.instance.item_hash}`} target="_blank" rel="noreferrer">Explorer</a>
            </div>

            {#if entry.details.error}
              <p class="alert error">{entry.details.error}</p>
            {/if}
          </AccordionSection>
        {/each}
      </section>
    {/if}
  </aside>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 9998;
    background: radial-gradient(circle at 88% 82%, rgba(233, 19, 21, 0.18), transparent 34%);
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
  .ping-strip,
  .actions,
  .section-head,
  .instance-topline,
  .link-row {
    display: flex;
    gap: 0.8rem;
    align-items: center;
    justify-content: space-between;
  }

  .eyebrow,
  .mini-label,
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
  .delete {
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 0.95rem;
    padding: 0.7rem 0.9rem;
    cursor: pointer;
    color: var(--relay-text);
    background: rgba(255, 255, 255, 0.05);
  }

  .primary {
    width: 100%;
    background: linear-gradient(135deg, var(--relay-blue), var(--relay-red));
    font-weight: 700;
  }

  .delete {
    background: rgba(233, 19, 21, 0.15);
    color: #ffd4d4;
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

  .ping-strip {
    margin-top: 0.9rem;
    padding: 0.85rem;
    border-radius: 1rem;
    background: rgba(1, 118, 206, 0.08);
  }

  .mini-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
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
