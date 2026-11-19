import {frontendTemplates,frontendFragmentRoot} from './frontend-layout.mjs';
import {transformSync} from 'esbuild';
// Viewer is the sole published HTML product. Keep the same 'web' build contract.
export function renderProductHtml(readSource) {
  const template=readSource(frontendTemplates.web).replaceAll('\r\n','\n');
  const expand=source=>source.replace(/<!-- include:([a-z-]+) -->/g,(_match,name)=>expand(readSource(`${frontendFragmentRoot}/${name}.html`).replaceAll('\r\n','\n').trim()));
  // Resolve shared brand at build time before asset closure and revisioning.
  // Run next to the opening workspace tag, before its controls can paint.
  // Both startup and the interactive layout use the same viewport rules.
  const html=expand(template.replace('<!-- viewer:initial-layout -->',()=>{
    const bootstrap=transformSync(readSource('src/ui/workspace-layout.js')+`
      const layout = createWorkspaceLayoutDetector()(readWorkspaceViewport(document));
      document.getElementById('viewer').dataset.layout = layout;
      document.body.dataset.layout = layout;
    `,{format:'iife',target:'es2022',minify:true,treeShaking:true}).code;
    return '<script>'+bootstrap+'</script>';
  })
    .replace(/<link rel="icon" href="data:,"\s*\/?>/g,'<!-- include:brand-icons -->'));
  if (/<!-- include:/.test(html)) throw new Error('Unresolved UI fragment');
  return {web:html.replace('<!DOCTYPE html>','<!DOCTYPE html>\n<!-- Generated from product templates and shared frontend fragments. -->')};
}
