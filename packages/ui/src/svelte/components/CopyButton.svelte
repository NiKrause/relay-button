<script>
  export let text = ''
  export let label = 'Copy'

  let copied = false

  async function handleCopy() {
    if (!text) return
    await navigator.clipboard.writeText(text)
    copied = true
    setTimeout(() => {
      copied = false
    }, 1200)
  }
</script>

<button type="button" class="copy-button" on:click={handleCopy}>
  {copied ? 'Copied' : label}
</button>

<style>
  .copy-button {
    border: 1px solid var(--relay-surface-border);
    border-radius: 999px;
    background: transparent;
    color: var(--relay-muted);
    padding: 0.28rem 0.7rem;
    font: 700 0.6563rem/1 var(--relay-font-mono);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    cursor: pointer;
    transition: color 150ms ease, border-color 150ms ease;
  }

  .copy-button:hover {
    color: var(--relay-text);
    border-color: var(--relay-cyan);
  }
</style>
