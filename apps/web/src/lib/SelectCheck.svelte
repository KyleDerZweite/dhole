<script lang="ts">
  import Select from './Select.svelte';
  let value = $state('a');
  let requiredValue = $state('');
  let changes = $state(0);
  let bubbledChanges = $state(0);
  let submitted = $state('none');
  let dialog: HTMLDialogElement;
  const options = [{value:'a',label:'Alpha'},{value:'b',label:'Beta',disabled:true},{value:'c',label:'Charlie'},{value:'d',label:'Delta'}, ...Array.from({length:20}, (_, index) => ({value:`item-${index}`,label:`Item ${index}`}))];
</script>
<main>
<h1>Select fixture</h1>
<form onchange={() => bubbledChanges++} onsubmit={(event) => {event.preventDefault(); submitted=JSON.stringify(Object.fromEntries(new FormData(event.currentTarget)));}}>
<label>Provider<Select bind:value {options} name="provider" onchange={(event) => {changes++; if (event.currentTarget.value !== value) throw new Error('change binding mismatch');}} /></label>
<label>Required provider<Select bind:value={requiredValue} options={[{value:'',label:'Choose provider'},{value:'x',label:'Example'}]} name="required" required /></label>
<label>Disabled provider<Select value="a" {options} name="disabledProvider" disabled /></label>
<button type="submit">Submit</button><button type="reset">Reset</button>
</form>
<p>Value: <output>{value}</output></p><p>Changes: {changes}. Bubbled: {bubbledChanges}.</p><p>Submitted: {submitted}</p>
<button type="button" onclick={() => dialog.showModal()}>Open dialog</button>
<dialog bind:this={dialog} onkeydown={(event) => {if(event.key==='Escape') dialog.close();}}>
<h2>Dialog select</h2>
<label>Dialog provider<Select {options} aria-label="Dialog provider" /></label>
<button type="button" onclick={() => dialog.close()}>Close dialog</button>
</dialog>
</main>
<style>
:global(body) {background:#181918;color:#eee;font:15px system-ui; margin:0;} main {max-width:450px;margin:40px auto;padding:20px} form{display:grid;gap:14px}label{display:grid;gap:8px}button{padding:10px}dialog{position:fixed; top:calc(100vh - 210px); margin:0 auto; width:250px; overflow:hidden; background:#232522;color:#fff;border:1px solid #888;border-radius:12px}dialog::backdrop{background:#0008}
</style>
