<script>
  export let title = ''
  export let open = false
</script>

<details class="accordion" {open}>
  <summary>{title}</summary>
  <div class="accordion-body">
    <slot />
  </div>
</details>

<style>
  .accordion {
    border: 1px solid var(--relay-surface-border);
    border-radius: 0.625rem;
    background: var(--relay-surface);
  }

  summary {
    cursor: pointer;
    list-style: none;
    padding: 0.75rem 0.9rem;
    color: var(--relay-text);
    font: 700 0.6875rem/1.1 var(--relay-font-mono);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  summary::-webkit-details-marker {
    display: none;
  }

  .accordion-body {
    padding: 0 0.9rem 0.9rem;
  }
</style>
