<script>
  export let tone = 'idle'
  export let pulse = false
</script>

<span class={`status-led ${tone} ${pulse ? 'pulse' : ''}`}></span>

<style>
  .status-led {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 999px;
    display: inline-block;
    box-shadow: 0 0 0 0.18rem rgba(168, 179, 199, 0.12);
    background: var(--relay-comet, #6b7690);
  }

  .status-led.ok {
    background: var(--relay-green);
    box-shadow: 0 0 0 0.18rem rgba(62, 220, 151, 0.16);
  }

  .status-led.caution {
    background: var(--relay-yellow);
    box-shadow: 0 0 0 0.18rem rgba(255, 194, 75, 0.16);
  }

  .status-led.error {
    background: var(--relay-red);
    box-shadow: 0 0 0 0.18rem rgba(255, 77, 106, 0.16);
  }

  .status-led.idle {
    background: var(--relay-blue);
    box-shadow: 0 0 0 0.18rem rgba(88, 199, 243, 0.16);
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
