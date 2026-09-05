<script lang="ts" generics="Value extends string">
  import { onMount, tick } from 'svelte';
  import { Check, ChevronDown } from '@lucide/svelte';

  type Option = { value: Value; label: string; disabled?: boolean };
  type ChangeEvent = Event & { currentTarget: HTMLInputElement };
  type Props = {
    options: readonly Option[];
    value?: Value;
    id?: string;
    name?: string;
    disabled?: boolean;
    required?: boolean;
    label?: string;
    'aria-label'?: string;
    'aria-describedby'?: string;
    placeholder?: string;
    onchange?: (event: ChangeEvent) => void;
  };

  const uid = $props.id();
  let {
    options, value = $bindable(options[0]?.value ?? '' as Value), id = uid,
    name, disabled = false, required = false, label, 'aria-label': ariaLabel,
    'aria-describedby': describedBy, placeholder = 'Choose an option', onchange,
  }: Props = $props();
  let trigger: HTMLButtonElement;
  let menu: HTMLDivElement;
  let field: HTMLInputElement;
  let open = $state(false);
  let active = $state(-1);
  let invalid = $state(false);
  let associatedLabel = $state('');
  let query = '';
  let queryAt = 0;
  const selected = $derived(options.find((option) => option.value === value));
  const accessibleLabel = $derived(ariaLabel || label || associatedLabel || name || placeholder);

  function position() {
    if (!open || !trigger || !menu) return;
    const rect = trigger.getBoundingClientRect();
    const edge = 8;
    const gap = 6;
    const below = window.innerHeight - rect.bottom - edge - gap;
    const above = rect.top - edge - gap;
    const upward = below < 180 && above > below;
    const width = Math.min(Math.max(rect.width, 160), window.innerWidth - edge * 2);
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(edge, Math.min(rect.left, window.innerWidth - width - edge))}px`;
    menu.style.top = upward ? 'auto' : `${rect.bottom + gap}px`;
    menu.style.bottom = upward ? `${window.innerHeight - rect.top + gap}px` : 'auto';
    menu.style.maxHeight = `${Math.max(0, Math.min(320, upward ? above : below))}px`;
  }

  async function reveal(index = options.findIndex((option) => option.value === value && !option.disabled)) {
    if (disabled || !options.length) return;
    active = index < 0 ? options.findIndex((option) => !option.disabled) : index;
    open = true;
    position();
    if (!menu.matches(':popover-open')) menu.showPopover();
    await tick();
    scrollActive();
  }

  function close() {
    if (menu?.matches(':popover-open')) menu.hidePopover();
    open = false;
    query = '';
  }

  function scrollActive() {
    menu?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  function move(direction: number) {
    for (let step = 1; step <= options.length; step++) {
      const index = (active + direction * step + options.length) % options.length;
      if (!options[index]?.disabled) { active = index; scrollActive(); return; }
    }
  }

  async function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled || disabled) return;
    const changed = value !== option.value;
    value = option.value;
    invalid = required && !value;
    close();
    trigger.focus({ preventScroll: true });
    await tick();
    if (changed) field.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function keydown(event: KeyboardEvent) {
    if (disabled || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Tab') { close(); return; }
    if (event.key === 'Escape') {
      if (open) { event.preventDefault(); event.stopPropagation(); close(); }
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Enter' || event.key === ' ') {
        if (open) void choose(active); else void reveal();
      } else if (event.key === 'Home' || event.key === 'End') {
        const enabled = options.map((option, index) => option.disabled ? -1 : index).filter((index) => index >= 0);
        void reveal(event.key === 'Home' ? enabled[0] : enabled.at(-1));
      } else if (!open) void reveal();
      else move(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key.length !== 1) return;
    event.preventDefault();
    const now = Date.now();
    query = now - queryAt < 700 ? query + event.key.toLocaleLowerCase() : event.key.toLocaleLowerCase();
    queryAt = now;
    const search = [...query].every((letter) => letter === query[0]) ? query[0]! : query;
    const start = search.length === 1 ? active + 1 : active;
    for (let step = 0; step < options.length; step++) {
      const index = (Math.max(0, start) + step) % options.length;
      const option = options[index]!;
      if (!option.disabled && option.label.toLocaleLowerCase().startsWith(search)) { void reveal(index); return; }
    }
  }

  onMount(() => {
    associatedLabel = [...(trigger.labels ?? [])].map((item) => {
      const clone = item.cloneNode(true) as HTMLLabelElement;
      clone.querySelectorAll('[data-select]').forEach((element) => element.remove());
      return clone.textContent?.trim() ?? '';
    }).join(' ');
    const initialValue = value;
    const form = field.form;
    const reset = () => { value = initialValue; invalid = false; close(); };
    form?.addEventListener('reset', reset);
    window.addEventListener('scroll', position, true);
    window.addEventListener('resize', position);
    return () => {
      form?.removeEventListener('reset', reset);
      window.removeEventListener('scroll', position, true);
      window.removeEventListener('resize', position);
    };
  });

  $effect(() => { if (disabled) close(); });
</script>

<span class="select-control" data-select>
  <button bind:this={trigger} {id} type="button" class="select-trigger" role="combobox"
    disabled={disabled || !options.length} aria-label={accessibleLabel} aria-expanded={open}
    aria-haspopup="listbox" aria-controls={`${uid}-listbox`} aria-activedescendant={open && active >= 0 ? `${uid}-option-${active}` : undefined}
    aria-required={required} aria-invalid={invalid || undefined} aria-describedby={[describedBy, invalid ? `${uid}-error` : ''].filter(Boolean).join(' ') || undefined}
    onclick={() => { if (open) close(); else void reveal(); }} onkeydown={keydown}>
    <span class:placeholder={!selected}>{selected?.label ?? placeholder}</span>
    <ChevronDown size={16} class={open ? 'chevron rotated' : 'chevron'} aria-hidden="true" />
  </button>
  <input bind:this={field} class="select-form-value" type="text" {name} {value} {disabled} {required}
    tabindex="-1" aria-hidden="true" autocomplete="off" {onchange}
    onfocus={() => trigger.focus({ preventScroll: true })}
    oninvalid={(event) => { event.preventDefault(); invalid = true; trigger.focus({ preventScroll: true }); }} />
  <div bind:this={menu} id={`${uid}-listbox`} class="select-menu" role="listbox" aria-label={accessibleLabel}
    popover="auto" ontoggle={(event) => { open = event.newState === 'open'; if (!open) query = ''; }}>
    {#each options as option, index (option.value)}
      <div id={`${uid}-option-${index}`} class="select-option" class:highlighted={active === index}
        role="option" aria-selected={option.value === value} aria-disabled={option.disabled || undefined}
        tabindex="-1" data-index={index} onpointerdown={(event) => event.preventDefault()}
        onpointermove={() => { if (!option.disabled) active = index; }} onclick={(event) => { event.preventDefault(); void choose(index); }}
        onkeydown={keydown}>
        <span>{option.label}</span>
        {#if option.value === value}<Check size={15} aria-hidden="true" />{/if}
      </div>
    {/each}
  </div>
  {#if invalid}<span id={`${uid}-error`} class="select-error">Choose an option.</span>{/if}
</span>

<style>
  .select-control { position: relative; display: block; min-width: 0; width: 100%; }
  .select-form-value { position: absolute; width: 1px; height: 1px; padding: 0; border: 0; opacity: 0; pointer-events: none; }
  .select-trigger { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; min-height: 40px; padding: 9px 11px; border: 1px solid var(--line-strong, #464440); border-radius: 8px; background: var(--panel, #1d1c1a); color: var(--text, #f2f0e9); font: inherit; text-align: left; cursor: pointer; }
  .select-trigger > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .select-trigger:hover:not(:disabled), .select-trigger[aria-expanded="true"] { border-color: var(--rust-bright, #dc825c); }
  .select-trigger:focus-visible { outline: 2px solid var(--rust-bright, #dc825c); outline-offset: 3px; }
  .select-trigger:disabled { cursor: not-allowed; opacity: .55; }
  .select-trigger[aria-invalid="true"] { border-color: var(--danger, #f07870); }
  .placeholder { color: var(--muted, #aaa69e); }
  .select-trigger :global(.chevron) { flex-shrink: 0; color: var(--muted, #aaa69e); transition: transform 120ms ease; }
  .select-trigger :global(.rotated) { transform: rotate(180deg); }
  .select-menu { position: fixed; inset: auto; margin: 0; box-sizing: border-box; padding: 5px; overflow-y: auto; overscroll-behavior: contain; border: 1px solid var(--line-strong, #464440); border-radius: 10px; background: var(--panel-raised, #242321); color: var(--text, #f2f0e9); box-shadow: 0 14px 38px #0005; font: inherit; }
  .select-menu::backdrop { background: transparent; }
  .select-option { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 36px; padding: 8px 10px; border-radius: 6px; cursor: pointer; }
  .select-option > span { min-width: 0; overflow-wrap: anywhere; }
  .select-option :global(svg) { flex-shrink: 0; color: var(--rust-bright, #dc825c); }
  .select-option.highlighted { background: color-mix(in srgb, var(--rust-bright, #dc825c) 16%, transparent); }
  .select-option[aria-selected="true"] { font-weight: 600; }
  .select-option[aria-disabled="true"] { color: var(--muted, #aaa69e); opacity: .5; cursor: not-allowed; }
  .select-error { display: block; margin-top: 5px; color: var(--danger, #f07870); font-size: 12px; }
  @media (prefers-reduced-motion: reduce) { .select-trigger :global(.chevron) { transition: none; } }
</style>
