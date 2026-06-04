<script>
  export let open = false
  export let onToggle = () => {}
  export let mode = 'floating'
</script>

<button class={`launcher ${mode} ${open ? 'open' : ''}`} type="button" on:click={onToggle}>
  <span>Sponsor Relay</span>
</button>

<style>
  .launcher {
    border: 2px solid var(--relay-launcher-border);
    border-radius: 999px;
    padding: 0.9rem 1.2rem;
    background: linear-gradient(135deg, var(--relay-blue) 0%, var(--relay-red) 100%);
    color: white;
    box-shadow: 0 18px 40px rgba(79, 70, 229, 0.28);
    font: 700 0.84rem/1 var(--relay-font-heading);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    cursor: pointer;
    transition: transform 180ms ease;
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
    padding: 0.55rem 0.9rem;
    font-size: 0.78rem;
  }

  .launcher:hover,
  .launcher.open {
    transform: translateY(-2px) scale(1.02);
  }
  </style>
