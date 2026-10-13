<!-- Test-only wrapper: the header button and the panel sharing one open state. -->
<script lang="ts">
  import type { AccountsStore } from '../accounts.ts';
  import AccountsButton from './AccountsButton.svelte';
  import AccountsPanel from './AccountsPanel.svelte';

  let { accounts, initiallyOpen = false }: { accounts: AccountsStore; initiallyOpen?: boolean } = $props();
  let open = $state(false);
  $effect.pre(() => { if (initiallyOpen) open = true; });
</script>

<header><AccountsButton {accounts} bind:open /></header>
<AccountsPanel {accounts} bind:open />
