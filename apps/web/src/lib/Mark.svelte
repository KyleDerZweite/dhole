<script lang="ts">
  import mascot from './mascot.svg';
  export let size = 34;
  export let compact = false;
</script>

<img class:compact class="mark" src={mascot} width={size} height={size} alt="Dhole, the red forest dog" />
