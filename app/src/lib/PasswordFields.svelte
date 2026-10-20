<script lang="ts">
  import { MIN_PASSWORD_LENGTH } from "$lib/background";

  let { password = $bindable(""), repeat = $bindable("") }: { password: string; repeat: string } = $props();
</script>

<p>Set a password. It encrypts your Master Mnemonic on this device and unlocks the wallet.</p>
<label>
  Password (at least {MIN_PASSWORD_LENGTH} characters)
  <input type="password" autocomplete="new-password" bind:value={password} data-new-password />
</label>
<label>
  Repeat password
  <input type="password" autocomplete="new-password" bind:value={repeat} data-repeat-password />
</label>

<style>
  label {
    display: block;
    margin-bottom: 0.5rem;
  }
</style>
