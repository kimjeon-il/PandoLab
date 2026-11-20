import { createMobileSheetPresentation } from "./mobile-sheet-presentation.js";
import { createWorkspaceLayoutDetector, isMobileWorkspaceLayout, readWorkspaceViewport, WORKSPACE_COARSE_POINTER } from "./workspace-layout.js";
import { createMenuPositionScheduler } from "./menu-presentation.js";
import { createSearchToolbarPresentation } from "./search-toolbar-presentation.js";

/** WorkspaceSurfaces: extracted application responsibility.
 * Dependencies are explicitly wired once by the composition modules.
 * Mutable bindings stay local; exported accessors retain live identity.
 */
export function createWorkspaceSurfaces() {
  const registeredSurfaces=['search','details'];
  const MOBILE_SHEET_HISTORY_KEY = '__pandolabMobileSheet';
  const listeners=[];
  const listen=(target,type,listener)=>{target.addEventListener(type,listener);listeners.push(()=>target.removeEventListener(type,listener));};
  let dependencies, mobileSheets;
  let detectLayoutMode;
  let layoutMode;
  let isMobile;
  let lastOverlayTrigger;
  let pendingLayoutChange = false;
  let surfaceController;
  let MOBILE_SHEET_IDS;
  let ignoreNextMobileSheetPopstate;
  let mobileViewportHeight;
  let menuPositionScheduler;
  let searchToolbarPresentation;
  let searchFocusFrame = 0;
  let searchComposing = false;
  function connect(ports) {
    if (dependencies) throw new Error('workspace-surfaces already connected');
    dependencies = ports;
  }






  function mobileSheetHistoryKind() {
    return window.history.state?.[MOBILE_SHEET_HISTORY_KEY] || null;
  }

  function trackMobileSheetHistory(kind) {
    if (!isMobile() || !kind) return;
    const currentState = window.history.state && typeof window.history.state === 'object' ? window.history.state : {};
    const nextState = { ...currentState, [MOBILE_SHEET_HISTORY_KEY]: kind };
    if (mobileSheetHistoryKind()) window.history.replaceState(nextState, '', window.location.href);
    else window.history.pushState(nextState, '', window.location.href);
  }

  function releaseMobileSheetHistory() {
    if (!mobileSheetHistoryKind()) return;
    ignoreNextMobileSheetPopstate = true;
    window.history.back();
  }



  function syncVisibleViewport() {
    const app = (0, dependencies.platform.$)('app');
    if (!app) return;
    app.style.setProperty('--workspace-visible-height', Math.round(mobileViewportHeight()) + 'px');
    app.style.setProperty('--workspace-visible-top', Math.round(window.visualViewport?.offsetTop || 0) + 'px');
    const bottom=Math.max(0,window.innerHeight-mobileViewportHeight()-(window.visualViewport?.offsetTop||0));
    app.style.setProperty('--workspace-bottom-offset', Math.round(bottom) + 'px');
  }

  function refreshMapSheetMetrics() {
    const panels = Object.values(MOBILE_SHEET_IDS).map(id => (0, dependencies.platform.$)(id)).filter(Boolean);
    syncVisibleViewport();
    if (!isMobile()) {
      panels.forEach(panel => {
        panel.style.removeProperty('--sheet-height');
        panel.removeAttribute('data-sheet-snap');
      });
      document.body.classList.remove('map-sheet-dragging');
      return;
    }
    panels.forEach(panel => {
      if (mobileSheets.activeDrag?.panel !== panel) mobileSheets.setMobileSheetHeight(panel, mobileSheets.snapIndex.get(panel.id));
    });
  }

  function applyLayoutMode({ initial = false } = {}) {
    const nextLayout = detectLayoutMode();
    if (nextLayout !== layoutMode && (mobileSheets.activeDrag || mobileSheets.settling || searchComposing)) {
      pendingLayoutChange = true;
      return false;
    }
    const previous = layoutMode;
    if (previous !== nextLayout) {
      cancelAnimationFrame(searchFocusFrame);
      searchFocusFrame = 0;
    }
    pendingLayoutChange = false;
    layoutMode = nextLayout;
    const app = (0, dependencies.platform.$)('app');
    surfaceController.syncLayout(previous);
    if (isMobileWorkspaceLayout(previous) && !isMobile()) releaseMobileSheetHistory();
    else if (isMobile() && !isMobileWorkspaceLayout(previous) && surfaceController.activeMobileSheet) {
      trackMobileSheetHistory(surfaceController.activeMobileSheet);
    }
    surfaceController.render();
    // Publish the layout only after its open-surface classes are in place.
    // A transient hidden sheet can blur an existing input in WebView2.
    if (app) app.dataset.layout = layoutMode;
    document.body.dataset.layout = layoutMode;
    searchToolbarPresentation.sync();
    refreshMapSheetMetrics();
    menuPositionScheduler.schedule();
    if (!initial && previous !== layoutMode) (0, dependencies.mapHostView.queueMapResize)('layout-mode-change');
    return previous !== layoutMode;
  }

  function syncOverlayState() {
    const view = surfaceController.render();
    if (!surfaceController.isOpen('search')) {
      dependencies.domains.objectSearchController?.cancelSearch();
      cancelAnimationFrame(searchFocusFrame);
      searchFocusFrame = 0;
    } else {
      dependencies.domains.objectSearchController?.render(true);
    }
    searchToolbarPresentation.sync();
    refreshMapSheetMetrics();
    menuPositionScheduler.schedule();
    if (layoutMode !== 'wide') (0, dependencies.mapHostView.queueMapResize)('panel-layout');
    return view;
  }

  function focusSurfaceTrigger(surface) {
    const ids = isMobile()
      ? { search: 'map',details: 'map' }
      : { search: 'objectSearchBtn',details: 'objectDetailCloseBtn' };
    const panelId = { search: 'objectSearchSurface',details:'objectDetailSurface' }[surface];
    const rememberedTrigger = !isMobile()&&lastOverlayTrigger?.isConnected
      && lastOverlayTrigger.getClientRects().length > 0
      && lastOverlayTrigger.getAttribute('aria-controls') === panelId
      ? lastOverlayTrigger
      : null;
    const trigger = rememberedTrigger || [(0, dependencies.platform.$)(ids[surface]),
      isMobile() ? (0, dependencies.platform.$)('mobileMenuBtn') : lastOverlayTrigger,
      (0, dependencies.platform.$)('map')].find(candidate => candidate?.getClientRects().length > 0);
    trigger?.focus({ preventScroll: true });
  }


  function closeActiveMobileSheet({ restoreFocus = false, syncHistory = true } = {}) {
    if (!isMobile() || !surfaceController.activeMobileSheet) return;
    const kind = surfaceController.activeMobileSheet;
    const surface = kind;
    const panel = mobileSheets.mobileSheetPanel(kind);
    surfaceController.close(surface);
    mobileSheets.resetMobileSheetSession(panel);
    syncOverlayState();
    if (syncHistory) releaseMobileSheetHistory();
    if (restoreFocus) focusSurfaceTrigger(surface);
    if (restoreFocus) lastOverlayTrigger = null;
  }

  function closeMobileSheets(except = null, { restoreFocus = false } = {}) {
    if (isMobile()) {
      const exceptKind = registeredSurfaces.includes(except) ? except : null;
      if (surfaceController.activeMobileSheet && surfaceController.activeMobileSheet !== exceptKind) closeActiveMobileSheet({ restoreFocus });
      return;
    }
    for(const surface of registeredSurfaces) if (surface !== except) surfaceController.close(surface);
    syncOverlayState();
    if (restoreFocus && lastOverlayTrigger?.isConnected) lastOverlayTrigger.focus({ preventScroll: true });
    if (restoreFocus) lastOverlayTrigger = null;
  }

  function openSurface(surface, { trigger = null } = {}) {
    if(!registeredSurfaces.includes(surface))return false;
    if (dependencies.projectState.state.projectReplacing) return false;
    if(surfaceController.isOpen(surface))return true;
    const activeTrigger = trigger instanceof HTMLElement ? trigger : document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!surfaceController.open(surface)) return false;
    if (activeTrigger) lastOverlayTrigger = activeTrigger;
    if (isMobile()) {
      const kind = surface;
      const panel = mobileSheets.mobileSheetPanel(kind);
      mobileSheets.resetMobileSheetSession(panel);
      trackMobileSheetHistory(kind);
    }
    syncOverlayState();
    if (surface === 'search') {
      cancelAnimationFrame(searchFocusFrame);
      searchFocusFrame = requestAnimationFrame(() => {
        searchFocusFrame = 0;
        if (surfaceController.isOpen('search') && !dependencies.projectState.state.projectReplacing
          && !document.activeElement?.closest('.ui-modal, [aria-modal="true"]')) {
          (0, dependencies.platform.$)('objectSearchInput')?.focus({ preventScroll: true });
        }
      });
    }
    return true;
  }

  function closeSurface(surface, { restoreFocus = false, syncHistory = true } = {}) {
    if(!registeredSurfaces.includes(surface))return false;
    const mobileKind = isMobile() ? surface : null;
    const mobilePanel = mobileKind ? mobileSheets.mobileSheetPanel(mobileKind) : null;
    if (!surfaceController.close(surface)) return;
    if (mobilePanel) mobileSheets.resetMobileSheetSession(mobilePanel);
    syncOverlayState();
    if (mobileKind && syncHistory) releaseMobileSheetHistory();
    if (restoreFocus) focusSurfaceTrigger(surface);
    if (restoreFocus) lastOverlayTrigger = null;
  }

  function toggleSurface(surface, trigger = null) {
    if (surfaceController.isOpen(surface)) {
      closeSurface(surface, { restoreFocus: true });
    } else {
      openSurface(surface, { trigger });
    }
  }

  function initializeWorkspaceSurfaces() {
    const detect = createWorkspaceLayoutDetector();
    const coarsePointer = window.matchMedia(WORKSPACE_COARSE_POINTER);
    detectLayoutMode = () => detect({
      ...readWorkspaceViewport(document, coarsePointer.matches),
      editingText: searchComposing || !!document.activeElement?.matches('input, textarea, select, [contenteditable="true"]'),
    });
    listen(coarsePointer,'change', () => applyLayoutMode());

    (layoutMode = detectLayoutMode());

    (isMobile = () => isMobileWorkspaceLayout(layoutMode));

    (lastOverlayTrigger = null);

    (surfaceController = (0, dependencies.surfaceFactories.createSurfaceController)({ getElement: dependencies.platform.$, getLayout: () => layoutMode, document }));

















    (MOBILE_SHEET_IDS = Object.freeze({details:'objectDetailSurface'}));
    mobileSheets=createMobileSheetPresentation({document,window,getElement:dependencies.platform.$,getLayout:()=>layoutMode,panelIds:MOBILE_SHEET_IDS,
      onSync:syncOverlayState,onClose:closeActiveMobileSheet,
      onResumeLayout:()=>{if(pendingLayoutChange){pendingLayoutChange=false;applyLayoutMode();}},
      onLayoutChange:()=>dependencies.mapHostView.queueMapResize('panel-layout'),
    });









    (ignoreNextMobileSheetPopstate = false);

    (mobileViewportHeight = () => window.visualViewport?.height || window.innerHeight);



    menuPositionScheduler = createMenuPositionScheduler(() => searchToolbarPresentation.position());
    searchToolbarPresentation = createSearchToolbarPresentation({
      document,
      panel: (0, dependencies.platform.$)('objectSearchSurface'),
      toolbar: document.querySelector('.map-command-toolbar'),
      slot: document.querySelector('.map-command-search'),
      isOpen: () => surfaceController.isOpen('search'),
      isMobile,
      schedulePosition: () => menuPositionScheduler.schedule(),
    });
    listen(dependencies.platform.$('objectSearchInput'),'compositionstart', () => { searchComposing = true; });
    listen(dependencies.platform.$('objectSearchInput'),'compositionend', () => {
      searchComposing = false;
      if (pendingLayoutChange) applyLayoutMode();
    });
    const searchInput=dependencies.platform.$('objectSearchInput');
    const openDockedSearch=()=>{
      if(isMobile()&&!surfaceController.isOpen('details'))openSurface('search',{trigger:searchInput});
    };
    listen(searchInput,'focus',openDockedSearch);
    listen(searchInput,'click',openDockedSearch);
    listen(window,'resize',()=>{if(!applyLayoutMode())refreshMapSheetMetrics();menuPositionScheduler.schedule();});
    listen(window,'orientationchange',()=>{refreshMapSheetMetrics();dependencies.mapHostView.queueMapResize('orientation-change');});
    listen(window,'popstate',event=>{
      if(ignoreNextMobileSheetPopstate){ignoreNextMobileSheetPopstate=false;return;}
      if(isMobile()&&surfaceController.activeMobileSheet){
        const select=document.querySelector('.ui-select-popover:not([hidden])');
        if(select)dependencies.uiControlServices.selectController.closeAll({restoreFocus:true});
        else {closeActiveMobileSheet({restoreFocus:true,syncHistory:false});return;}
        trackMobileSheetHistory(surfaceController.activeMobileSheet);return;
      }
      if(event.state?.[MOBILE_SHEET_HISTORY_KEY]){const next={...event.state};delete next[MOBILE_SHEET_HISTORY_KEY];window.history.replaceState(next,'',window.location.href);}
    });
    if(window.visualViewport)listen(window.visualViewport,'resize', () => {
      refreshMapSheetMetrics();
      menuPositionScheduler.schedule();
    });
    if(window.visualViewport)listen(window.visualViewport,'scroll', () => { refreshMapSheetMetrics(); menuPositionScheduler.schedule(); });
  }

  return Object.freeze({
    connect,
    initializeWorkspaceSurfaces,
    dispose(){listeners.forEach(remove=>remove());if(mobileSheets)mobileSheets.dispose();if(menuPositionScheduler)menuPositionScheduler.cancel();if(searchToolbarPresentation)searchToolbarPresentation.dispose();cancelAnimationFrame(searchFocusFrame);},
    get MOBILE_SHEET_IDS() { return MOBILE_SHEET_IDS; },
    get applyLayoutMode() { return applyLayoutMode; },
    get bindMobileSheetSurface() { return mobileSheets.bindMobileSheetSurface; },
    get closeActiveMobileSheet() { return closeActiveMobileSheet; },
    get closeMobileSheets() { return closeMobileSheets; },
    get closeSurface() { return closeSurface; },
    get isMobile() { return isMobile; },
    get layoutMode() { return layoutMode; },
    get openSurface() { return openSurface; },
    get refreshMapSheetMetrics() { return refreshMapSheetMetrics; },
    get focusSurfaceTrigger() { return focusSurfaceTrigger; },
    get setMobileSheetHeight() { return mobileSheets.setMobileSheetHeight; },
    get surfaceController() { return surfaceController; },
    get syncOverlayState() { return syncOverlayState; },
    get toggleSurface() { return toggleSurface; },
    get trackMobileSheetHistory() { return trackMobileSheetHistory; },
  });
}
