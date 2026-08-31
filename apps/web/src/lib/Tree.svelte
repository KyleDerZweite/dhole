<script lang="ts">
  import type { AgentNode } from './types';
  export let nodes: AgentNode[] = [];
  export let depth = 0;

  const controlLabel = (node: AgentNode): string => {
    if (node.control === 'observe_only' || node.evidence === 'provider') return 'observed native child';
    if (node.control === 'uncertain' || node.evidence === 'heuristic') return 'uncertain heuristic child';
    return 'fully controlled child';
  };

  const controlClass = (node: AgentNode): string => {
    if (node.control === 'observe_only' || node.evidence === 'provider') return 'observed';
    if (node.control === 'uncertain' || node.evidence === 'heuristic') return 'heuristic';
    return 'full';
  };
</script>

{#each nodes as node (node.id)}
  {#if node.children?.length}
    <details class="tree-node" open={depth < 2} style={`--depth:${depth}`}>
      <summary>
        <span class={`tree-dot ${controlClass(node)}`} aria-hidden="true"></span>
        <a class="tree-name tree-agent-link" href={`/agents/${encodeURIComponent(node.id)}`} aria-label={`Open agent detail for ${node.name}`} onclick={(event) => event.stopPropagation()}>{node.name}</a>
        <span class="muted">{node.state ?? 'unknown'}</span>
        <span class={`evidence ${controlClass(node)}`}>{controlLabel(node)}</span>
      </summary>
      <div class="tree-meta">
        {#if node.runtimeId}<span>Runtime {node.runtimeId}</span>{/if}
        {#if node.machineId}<span>Machine {node.machineId}</span>{/if}
        {#if node.startedAt}<span>{new Date(node.startedAt).toLocaleString()}</span>{/if}
      </div>
      <svelte:self nodes={node.children} depth={depth + 1} />
    </details>
  {:else}
    <div class="tree-node tree-leaf" style={`--depth:${depth}`}>
      <div class="tree-summary">
        <span class={`tree-dot ${controlClass(node)}`} aria-hidden="true"></span>
        <a class="tree-name tree-agent-link" href={`/agents/${encodeURIComponent(node.id)}`} aria-label={`Open agent detail for ${node.name}`}>{node.name}</a>
        <span class="muted">{node.state ?? 'unknown'}</span>
        <span class={`evidence ${controlClass(node)}`}>{controlLabel(node)}</span>
      </div>
      <div class="tree-meta">
        {#if node.runtimeId}<span>Runtime {node.runtimeId}</span>{/if}
        {#if node.machineId}<span>Machine {node.machineId}</span>{/if}
        {#if node.startedAt}<span>{new Date(node.startedAt).toLocaleString()}</span>{/if}
      </div>
    </div>
  {/if}
{/each}
