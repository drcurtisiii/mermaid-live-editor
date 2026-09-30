<script lang="ts">
  import { defaultState } from '$/constants';
  import { getDesktop, type DesktopDocument } from '$/util/desktop';
  import { inputState, updateCode } from '$/util/state.svelte';
  import { onMount } from 'svelte';

  interface Props {
    // Resolves once the editor's own initialization (initHandler) is done.
    initialized: Promise<boolean>;
  }

  let { initialized }: Props = $props();

  const desktop = getDesktop();
  let reporting = $state(false);

  const applyDocument = (doc: DesktopDocument) => {
    updateCode(doc.code, { resetPanZoom: true, updateDiagram: true });
  };

  onMount(() => {
    if (!desktop) return;
    desktop.onLoadDocument(applyDocument);
    void initialized.then(async () => {
      const doc = await desktop.ready();
      applyDocument(doc ?? { code: defaultState.code, name: 'Untitled' });
      reporting = true;
    });
  });

  $effect(() => {
    const code = inputState.code;
    if (desktop && reporting) {
      desktop.codeChanged(code);
    }
  });
</script>
