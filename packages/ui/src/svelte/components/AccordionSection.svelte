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
    border: 1px solid var(--relay-panel-border);
    border-radius: 1rem;
    background: rgba(255, 255, 255, 0.035);
  }

  summary {
    cursor: pointer;
    list-style: none;
    padding: 0.8rem 0.95rem;
    color: var(--relay-text);
    font: 700 0.8rem/1.1 var(--relay-font-heading);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  summary::-webkit-details-marker {
    display: none;
  }

  .accordion-body {
    padding: 0 0.95rem 0.95rem;
  }
</style>
