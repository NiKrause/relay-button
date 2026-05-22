<script>
  export let tone = 'idle'
  export let pulse = false
</script>

<span class={`status-led ${tone} ${pulse ? 'pulse' : ''}`}></span>

<style>
  .status-led {
    width: 0.65rem;
    height: 0.65rem;
    border-radius: 999px;
    display: inline-block;
    box-shadow: 0 0 0 0.18rem rgba(255, 255, 255, 0.06);
    background: #64748b;
  }

  .status-led.ok {
    background: var(--relay-green);
  }

  .status-led.caution {
    background: var(--relay-yellow);
  }

  .status-led.error {
    background: var(--relay-red);
  }

  .status-led.idle {
    background: var(--relay-blue);
  }

  .pulse {
    animation: relay-pulse 1.6s ease-in-out infinite;
  }

  @keyframes relay-pulse {
    0%,
    100% {
      transform: scale(1);
      opacity: 0.75;
    }

    50% {
      transform: scale(1.25);
      opacity: 1;
    }
  }
</style>
