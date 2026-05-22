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
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.04);
    color: var(--relay-text);
    padding: 0.28rem 0.7rem;
    font: 600 0.73rem/1 var(--relay-font-body);
    cursor: pointer;
  }
</style>
