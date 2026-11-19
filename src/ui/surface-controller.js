import { isMobileWorkspaceLayout } from "./workspace-layout.js";

/** Single active Viewer drawer; no duplicate selection/document state. */
export function createSurfaceController({getElement,getLayout,document}) {
  const panels={search:'objectSearchSurface',details:'objectDetailSurface'};
  let activeSurface=null,activeMobileSheet=null;
  function open(surface) {
    if(!Object.hasOwn(panels,surface))return false;
    activeSurface=surface;
    activeMobileSheet=isMobileWorkspaceLayout(getLayout())?surface:null;
    return true;
  }
  function close(surface) {
    if(!Object.hasOwn(panels,surface)||activeSurface!==surface)return false;
    activeSurface=null;
    activeMobileSheet=null;
    return true;
  }
  const isOpen=surface=>activeSurface===surface;
  function render({fileOpen=false}={}) {
    const layout=getLayout(),mobile=isMobileWorkspaceLayout(layout);
    for(const [surface,id] of Object.entries(panels)){
      const panel=getElement(id),opened=isOpen(surface);
      if(!panel)throw new TypeError('Missing workspace surface: '+id);
      const dockedSearch=mobile&&surface==='search'&&!isOpen('details');
      panel.classList.toggle('mobile-open',opened&&layout!=='wide');
      panel.classList.toggle('surface-open',opened);
      panel.classList.toggle('map-search-bar',dockedSearch);
      if(dockedSearch){
        panel.setAttribute('role','search');
        panel.removeAttribute('aria-modal');
        panel.removeAttribute('aria-hidden');
      }else if(mobile){
        panel.setAttribute('role','dialog');
        panel.setAttribute('aria-modal','false');
        panel.setAttribute('aria-hidden',String(!opened));
      }else{
        for(const attribute of ['aria-hidden','role','aria-modal'])panel.removeAttribute(attribute);
      }
      panel.inert=!opened&&!dockedSearch;
    }
    for(const id of ['objectSearchBtn','mobileSearchBtn']){
      const trigger=getElement(id);
      trigger?.classList.toggle('sheet-open',isOpen('search'));
      trigger?.setAttribute('aria-expanded',String(isOpen('search')));
    }
    document.body.classList.toggle('file-menu-open',fileOpen);
    document.body.classList.toggle('map-sheet-open',mobile&&!!activeMobileSheet);
    getElement('mobileFileBtn')?.classList.toggle('sheet-open',fileOpen);
    getElement('mobileFileBtn')?.setAttribute('aria-expanded',String(fileOpen));
    getElement('mobileBackdrop')?.setAttribute('aria-hidden',String(!fileOpen));
    return {searchOpen:isOpen('search'),detailsOpen:isOpen('details'),activeMobileSheet};
  }
  function syncLayout(previousLayout) {
    if(getLayout()===previousLayout)return;
    activeMobileSheet=isMobileWorkspaceLayout(getLayout())?activeSurface:null;
  }
  return Object.freeze({open,close,isOpen,render,syncLayout,get activeMobileSheet(){return activeMobileSheet;}});
}
