<script>
  export let open = false
  export let onToggle = () => {}
  export let mode = 'floating'
</script>

<button class={`launcher ${mode} ${open ? 'open' : ''}`} type="button" on:click={onToggle}>
  <svg class="mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <line x1="17" y1="15.4" x2="19.6" y2="13" class="mark-link" stroke-width="2.4" stroke-linecap="round" />
    <circle cx="11.5" cy="20.5" r="7" class="mark-node" />
    <circle cx="23.5" cy="9.5" r="4.2" fill="none" class="mark-peer" stroke-width="2.8" />
  </svg>
  <span>Relay Button</span>
</button>

<style>
  .launcher {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    border: 1px solid var(--relay-launcher-border);
    border-radius: 999px;
    padding: 0.75rem 1.1rem;
    background: var(--relay-launcher-bg);
    color: var(--relay-launcher-text);
    box-shadow: var(--relay-launcher-shadow);
    font: 700 0.78rem/1 var(--relay-font-mono);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    cursor: pointer;
    transition: transform 180ms ease, border-color 180ms ease;
  }

  .mark {
    width: 1.15rem;
    height: 1.15rem;
    flex: none;
  }

  .mark-node {
    fill: var(--relay-coral);
  }

  .mark-peer,
  .mark-link {
    stroke: var(--relay-cyan);
  }

  .launcher.floating {
    position: fixed;
    right: 1.4rem;
    bottom: 5.8rem;
    z-index: 10000;
  }

  .launcher.inline {
    position: relative;
    z-index: auto;
    padding: 0.5rem 0.85rem;
    font-size: 0.72rem;
  }

  .launcher:hover,
  .launcher.open {
    transform: translateY(-2px) scale(1.02);
    border-color: var(--relay-cyan);
  }
  </style>
