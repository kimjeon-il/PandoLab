import {presentViewerLoadStatus} from "./viewer-load-status.js";
import {createRuntimeContext} from "../runtime/runtime-context.js";
import {createMapProjectRuntime} from "../data/map-project-runtime.js";
import {createPlatformPorts} from "../runtime/platform-ports.js";
import {connectMapOwner} from "./map-owner-ports.js";
import {createBrowserProjectStorage} from "../data/browser-project-storage.js";
import {createNotificationPresentation} from "../ui/notification-presentation.js";
import {createApplicationLifecycle} from "./application-lifecycle.js";
import {createPreferencePresentation} from "../ui/preference-presentation.js";
import {createMapOwners} from "./map-owner-composition.js";
import {saveUserPreferences} from "../ui/user-preferences.js";
import {createDiagnosticLog,isRecoverableLoadError} from "../runtime/reliability-core.js";
import {createNavigationBindings} from "../ui/navigation-bindings.js";
import {createSelectController} from "../ui/select-controller.js";
import { createSelectionUiController } from "../ui/selection-ui-controller.js";
import { createObjectDetailsPanel } from "../ui/object-details-panel.js";
import { affiliationTypeAt } from "../document/territorial-affiliation.js";
import { createTooltipController } from "../ui/tooltip-controller.js";
import { installTimelineControls } from "../ui/timeline-controls.js";
import { createAppObjectSearchController } from "../ui/object-search-controller.js";
import { createSemanticIcon } from "../ui/icon-utils.js";
import { createEmptyState } from "../ui/empty-state.js";
import { createSelectionDomain } from "../document/selection-domain.js";
import { coreSelectionRefToWeb,webSelectionRefToCore } from "../document/core-object-ref.js";
import { normalizeObjectRef } from "../document/object-ref-identity.js";
import { createDocumentSession } from "../document/document-session.js";
import { createProjectDomain } from "../document/project-domain.js";
import {bindProjectDocumentIdentity} from '../data/map-project-identity.js';
import { createInitialDocument } from "../document/initial-document.js";
import { createViewerMap } from "./viewer-map.js";
import {createViewerInitialPresentation} from "./viewer-initial-presentation.js";
import {createViewerInitialMapSkeleton} from "./viewer-initial-map-skeleton.js";
import {createViewerPostPresentation} from "./viewer-post-presentation.js";
import {createViewerInspectorController} from "../ui/inspector/viewer-inspector-controller.js";
import { createMapSettings } from "../ui/app-map-settings.js";
import { layerStyle } from "../ui/layer-presentation.js";
import { DISTRIBUTION_RENDER_MODES } from "../document/distribution-model.js";
import { createSurfaceController } from "../ui/surface-controller.js";
import { createPreferencesDialog } from "../ui/preferences-dialog.js";
import {createProjectMonthClock} from "../document/project-month-clock.js";
import {territorialMembershipDelta} from "../document/territorial-entity-store.js";

export async function composeViewer({ productMode, meta }) {
  if(productMode!=='viewer')throw new Error('실행 설정이 올바르지 않습니다.');
  const get=id=>document.getElementById(id),status=get('viewerStatus');
  get('viewer').dataset.initialLoading='true';
  // Resolve the selected physical catalog once, using its published SHA.
  // Keep a visible startup status if the pinned source is missing or damaged.
  const assetBaseUrl=new URL('../',import.meta.url);
  const projectRuntime=createMapProjectRuntime({meta,assetBaseUrl});
  let physical;
  try{physical=await projectRuntime.hydratePhysicalMetadata();}
  catch(error){
    status.dataset.ready='false';
    presentViewerLoadStatus(status,'프로젝트 자료 카탈로그를 확인하지 못했습니다.',{error:true});
    throw error;
  }
  const runtimeMeta=Object.freeze({...meta,mapProject:projectRuntime.project,...physical});
  const runtimeContext=createRuntimeContext({productMode,meta:runtimeMeta,assetBaseUrl,platform:createPlatformPorts({kind:'browser'})});
  const projection='globe';
  let map,previousView,display,projectClock,syncStatus,preferencesDialog,presentedMonth=null;
  const inspectParams=new URLSearchParams(window.location.search);
  let inspectorController=null,objectDetailsPanel=null;
  const mapSkeleton=createViewerInitialMapSkeleton({
    setLoading:loading=>{get('viewer').dataset.initialLoading=String(loading);map.renderer.setInitialMapLoading(loading);},
    readRenderer:()=>map?.renderer,
  });
  const initialPresentation=createViewerInitialPresentation({onPresented:mapSkeleton.onFirstMapPresented});
  const preferencePresentation=createPreferencePresentation({document,window,productMode,onChange:change=>{
    if(!map)return;
    map.refreshAppearance(change);
    if(change.countryNamesChanged)syncStatus({refreshHover:true});
  }});
  const diagnostics=createDiagnosticLog({limit:250});
  const tooltipController=createTooltipController({document,window,tooltip:get('uiTooltip'),clamp:(value,min,max)=>Math.max(min,Math.min(max,value))});
  tooltipController.bind();
  const viewStorage=createBrowserProjectStorage({productMode,indexedDB:window.indexedDB,databaseName:'pandolab-viewer',storeName:'views',viewKey:'active-view'});
  const viewDocumentId=`map-project:${runtimeContext.meta.mapProject.projectId}:${runtimeContext.meta.dataRevision}`;
  const persistViewing=()=>{if(!map||map.viewState.projectReplacing)return;const record={documentId:viewDocumentId,viewingPresentation:map.capturePresentation(),savedAt:new Date().toISOString()},camera=map.renderer.cameraSnapshot();
    Promise.all([viewStorage.writeView(record),...(camera?.projection?[viewStorage.writeCamera(runtimeContext.meta.mapProject.projectId,camera)]:[])]).catch(error=>report(error,'보기 설정을 저장하지 못했습니다.','PL-WORKSPACE-WRITE-001'));syncStatus();};
  const owners=createMapOwners({productMode,readOnly:true,projection,buildMeta:runtimeContext.meta,platform:runtimeContext.platform,onViewingChange:persistViewing,resolveVisibilityGroup:ref=>map.objectQuery.layerGroupForObjectRef(ref),isObjectVisible:(group,id)=>map.objectQuery.objectRefVisible(map.objectQuery.layerItemObjectRef(group,id)),closeActiveOverlay:()=>surfaces.closeMobileSheets()});
  const surfaces=owners.workspaceSurfaces;
  const selectController=createSelectController({document,window});selectController.enhanceAll();
  const notifications=createNotificationPresentation({document,getElement:get,isMobile:()=>surfaces.isMobile(),protectErrorNotices:true});
  const report=(error,message='작업을 완료하지 못했습니다.',code='PL-MAP-OPERATION')=>notifications.reportOperationError(error,message,code);
  const readSavedCamera=async()=>{
    try {
      const camera=await viewStorage.readCamera(runtimeContext.meta.mapProject.projectId);
      if(camera?.projection==='globe'&&Array.isArray(camera.center)&&camera.center.length===2&&camera.center.every(Number.isFinite)&&Number.isFinite(camera.zoom)){
        return {globeRotation:[-camera.center[0],-Math.max(-90,Math.min(90,camera.center[1])),0],
          zoom:camera.zoom,bearing:camera.bearing,pitch:camera.pitch,roll:camera.roll};
      }
    } catch(error) {
      report(error,'지도 위치를 복원하지 못했습니다.','PL-WORKSPACE-READ-001');
    }
    return null;
  };
  const documentSession=createDocumentSession({productMode,readOnly:true,initialProject:createInitialDocument({appVersion:meta.appVersion})});
  const disposables=[tooltipController,selectController,preferencePresentation,surfaces,notifications,documentSession.commandOwner,initialPresentation];
  async function composeMap() {
  let openingPreserved=null;
  const projectDomain=createProjectDomain({productMode,readOnly:true,commandOwner:documentSession.commandOwner,documentModel:documentSession.documentModel,
    admitImportedProject:project=>bindProjectDocumentIdentity(project,runtimeContext.meta),
    readBuiltinSelectionCatalogs:()=>map?[{domain:'placeBuiltin',refs:map.placeSelectionReferences()},{domain:'hydroBuiltin',refs:map.hydroSelectionReferences()}]:[],publishCommand:()=>map.refreshSelection(),
    onProjectReset:async event=>{postPresentation.invalidate();searchController.cancelSearch();previousView=map.capturePresentation();await selectionDomain.resetProject(event.generation);selectionUiController.resetProject();map.renderingDomain.resetProjectGeneration(event.generation,{presentation:event.presentation,isCurrent:event.isCurrent,onPresented:event.onPresented});},
    replaceSnapshot:async(_project,{reason})=>{await map.setSession(activeSession,{source:reason==='builtin'?'builtin':'project',prepareView:async()=>{
      const project=activeSession.documentModel.snapshot(),bounds=project.projectSetup.initialMapBounds;let restoredCamera=false;
      const startupWorld=reason==='builtin'&&!initialPresentation.hasPresented();
      if(openingPreserved)map.projectSession.restoreViewingPresentation({documentId:project.documentId,viewingPresentation:openingPreserved});
      else {
        let workspace=null;
        try{workspace=await viewStorage.readView(viewDocumentId);}catch(error){report(error,'보기 설정을 복원하지 못했습니다.','PL-WORKSPACE-READ-001');}
        map.projectSession.restoreViewingPresentation(workspace?{...workspace,documentId:project.documentId}:null);
        if(!startupWorld){
          const camera=await readSavedCamera();
          if(camera){map.renderer.syncCameraFromState(camera);restoredCamera=true;}
        }
      }
      await map.loadPhysicalLand();
      if(!startupWorld&&!openingPreserved&&!restoredCamera){
        if(bounds)map.renderer.fitMapBounds([[bounds.west,bounds.south],[bounds.east,bounds.north]],map.mapProjection.currentMapSafeInsets());
        else map.navigation.resetView();
      }
    }});await map.renderer.waitForTemporalPresentation();return true;},
    restoreReplacement:async(_project,_generation,previousActive)=>{await map.setSession(activeSession,{
      source:previousActive?.source==='builtin'?'builtin':'project',view:previousView});
      await map.renderer.waitForTemporalPresentation();}});
  disposables.push(projectDomain);
  let selectionUiController;
  function presentMapHover({hover}) {
    tooltipController.setMapHover(hover?map.objectQuery.objectDisplayInfo(hover):null);
  }
  const selectionDomain=createSelectionDomain({commandOwner:documentSession.commandOwner,projectDomain,
    refAdapter:{fromCore:coreSelectionRefToWeb,toCore:ref=>webSelectionRefToCore(ref,{isStoredHydro:id=>documentSession.documentModel.get({domain:'hydro',id})!==null})},
    onSelectionChanged:snapshot=>{
      selectionUiController.sync(snapshot);
      objectDetailsPanel?.syncSelection(snapshot);
      inspectorController?.syncMapSelection(snapshot);
    },
    onHoverChanged:presentMapHover,
    requestRender:reason=>map.refreshSelection(reason)});
  disposables.push(selectionDomain);
  const selectionStatus=get('viewerSelectionStatus');
  selectionUiController=createSelectionUiController({window,document,selectionDomain,elements:{selectionStatus},
    resolveRef:value=>value,refExists:ref=>map.objectQuery.objectRefExists(ref),displayInfo:ref=>map.objectQuery.objectDisplayInfo(ref),
    presenters:{default:(ref,{refreshOnly}={})=>{
      selectionStatus.textContent=map.objectQuery.objectDisplayInfo(ref).name;
      if(refreshOnly===false)objectDetailsPanel?.reveal(ref);
    }},
    uiActions:{closeChooser:()=>map.closeObjectChooser(),clearPresenter:()=>{selectionStatus.textContent='';},syncLayerRows:()=>searchController.syncSelection()}});
  disposables.push(selectionUiController);
  const activeSession=Object.freeze({...documentSession,projectDomain,selectionDomain,selectionUiController});
  connectMapOwner('workspaceSurfaces',surfaces,{platform:{$:id=>get(id==='app'?'viewer':id)},projectState:{get state(){return map.viewState;}},
    surfaceFactories:{createSurfaceController},domains:{get objectSearchController(){return searchController;},get objectDetailsPanel(){return objectDetailsPanel;}},
    mapHostView:{queueMapResize:()=>{owners.mapHost.queueMapResize('panel-layout');}},
    uiControlServices:{selectController},get mapNavigation(){return map.navigation;}});
  surfaces.initializeWorkspaceSurfaces();
  objectDetailsPanel=createObjectDetailsPanel({
    document,surfaces,
    displayInfo:ref=>map.objectQuery.objectDisplayInfo(ref),
    relations:ref=>{
      const repository=map.entityRepository;
      const month=activeSession.commandOwner.state().timelineCursor;
      const row=repository.get(ref.id),parent=repository.parent(ref.id);
      const objectInfo=id=>map.objectQuery.objectDisplayInfo({domain:'territorial',type:'entity',id});
      const metadata=row?.properties?.metadata;
      const affiliationType=affiliationTypeAt(metadata,month);
      const lessee=affiliationType==='조차지'&&metadata?.builtinSubunit?.lesseeCountryId;
      return {
        parentName:parent?objectInfo(parent.id).name:'',
        affiliationType,
        affiliationSubjectName:lessee?objectInfo(lessee).name:'',
        children:repository.children(ref.id).map(child=>{
          const {name,flagUrl}=objectInfo(child.id);
          return {id:child.id,name,flagUrl,affiliationType:affiliationTypeAt(child.properties?.metadata,month)};
        }),
      };
    },
    selectObject:id=>selectionUiController.applyIntent({domain:'territorial',type:'entity',id}),
    hoverObject:(id,entered,isCurrent)=>{
      const ref=normalizeObjectRef({domain:'territorial',type:'entity',id});
      return selectionDomain.setHover(entered?ref:null,{source:'details',expectedKey:entered?'':ref.key,isCurrent});
    },
    onError:(error,operation)=>operation==='hover'
      ?report(error,'소속 객체를 강조하지 못했습니다.','PL-OBJECT-DETAIL-HOVER')
      :report(error,'소속 객체를 선택하지 못했습니다.','PL-OBJECT-DETAIL-SELECTION'),
  });
  disposables.push(objectDetailsPanel);
  const resetView=get('resetViewBtn');
  const syncResetView=()=>resetView.classList.toggle('is-world-view',map.renderer.isAtWorldView());
  map=createViewerMap({owners,runtimeContext,element:get('map'),projectDomain,documentSession:activeSession,isMobile:()=>surfaces.isMobile(),diagnostics,getInteractionStyle:()=>preferencePresentation.interactionStyle,onStatus:notifications.setActionStatus,isSafeKoreanErrorMessage:notifications.isSafeKoreanErrorMessage,getPreferences:()=>preferencePresentation.current,onPlacesSettled:action=>{if(action==='cancel')searchController.cancelSearch();else searchController.render();},onError:report,
    initialCamera:readSavedCamera(),onWorldFitChange:syncResetView,
    onMapPreparationStatus:(presentation,generation)=>{initialPresentation.observe(presentation,generation);mapSkeleton.reconsider();},isInitialPresentation:()=>!initialPresentation.hasPresented()});
  map.renderer.setInitialMapLoading(true);
  map.ready.then(()=>{
    const instance=map.renderer.map;
    instance.on('moveend',persistViewing);
    instance.on('moveend',syncResetView);
    syncResetView();
    disposables.push({dispose(){
      instance.off('moveend',persistViewing);
      instance.off('moveend',syncResetView);
    }});
  }).catch(error=>report(error,'지도 보기 설정을 연결하지 못했습니다.','PL-WORKSPACE-WRITE-001'));
  disposables.push(map);
  // One read-only inspector lifecycle for desktop, mobile, URL and keyboard.
  // The evidence UI remains an on-demand dynamic module, never a Viewer boot
  // dependency or a second document/selection owner.
  inspectorController=createViewerInspectorController({
    document,window,readOnly:documentSession.readOnly,
    inspectRequested:inspectParams.get('inspect')==='1',
    debugEnabled:inspectParams.get('debug')==='1',
    closeMobileSheets:()=>surfaces.closeMobileSheets(),
    createPanel:async()=>{
      const {createViewerReviewPanel}=await import("../ui/inspector/viewer-review-panel.js");
      return createViewerReviewPanel({document,window,map,documentSession:activeSession,
        isBuiltinMap:()=>projectDomain.activeProject()?.source==='builtin',meta:runtimeContext.meta,
        readMonth:()=>activeSession.commandOwner.state().timelineCursor,
        readDiagnostics:()=>diagnostics.snapshot(),
        readPerformance:()=>typeof window.__PANDOLAB_PERFORMANCE_REPORT__==='function'
          ?window.__PANDOLAB_PERFORMANCE_REPORT__():null,
        onError:error=>diagnostics.push({category:'e4-review-data',
          errorCode:error?.code||'PL-E4-REVIEW',technicalMessage:error?.message||String(error)})});
    },
    onError:report,
  });
  disposables.push(inspectorController);
  // One complete historical project needs no neighbouring-month prefetch.
  const searchController=createAppObjectSearchController({window,document,getElement:get,state:map.viewState,
    objectSearchGroupKeys:map.objectPresentation.LAYER_SEARCH_GROUP_KEYS,listObjectSearchItems:map.objectCatalog.listObjectSearchItems,
    layerItemObjectRef:map.objectQuery.layerItemObjectRef,selectionDomain,
    getProjectScope:()=>projectDomain.activeProjectScope(),
    libraryAvailable:()=>projectDomain.activeProject()?.source==='builtin',
    isSearchOpen:()=>surfaces.surfaceController.isOpen('search')&&map.searchActive(),isSearchSurfaceOpen:()=>surfaces.surfaceController.isOpen('search'),
    createIcon:(name,className)=>createSemanticIcon(document,name,className),createEmptyState:createEmptyState.bind(null,document),
    onSearchError:report,cancelBuiltinSearch:()=>map.cancelSearch(),builtinSearch:value=>map.searchPlaces(value),
    selectObjectSearchItem:map.navigation.selectObjectSearchItem,focusObjectRef:map.objectQuery.focusObjectRef,
    closeSearchAfterSingleSelection:()=>surfaces.closeSurface('search')});
  disposables.push(searchController);
  searchController.bind();surfaces.applyLayoutMode({initial:true});
  map.refreshAppearance({rerender:false});
  // Background assets are global; hydro identities must wait for the Core
  // replacement below. The resource owner handles errors and shared requests.
  // The canonical white map is revealed when its country/land frame is ready.
  Promise.resolve(map.loadPhysicalResources({includeHydro:false})).then(
    mapSkeleton.reconsider,mapSkeleton.reconsider);
  syncStatus=({refreshHover=false}={})=>{
    if(map&&!projectDomain.isOpening()){
      selectionUiController.syncNow(null,{force:true});
      const snapshot=selectionDomain.snapshot();
      objectDetailsPanel.syncSelection(snapshot);
      if(refreshHover)presentMapHover(snapshot);
    }
  };
  // Scene updates own catalog revisions. Search rendering only filters
  // the current prepared catalog; it does not manufacture data changes.
  const search=()=>searchController.render();
  // Accepted map frames are published independently of optional search/overlay
  // hydration. Each post task is generation-scoped and may never roll a map back.
  const postPresentation=createViewerPostPresentation({
    hydrate:async isCurrent=>{await searchController.completeHydration({isCurrent});},
    refresh:search,
    // replaceSnapshot.prepareView already launched physical background loading.
    afterMap:[()=>surfaces.syncOverlayState(),()=>syncStatus(),()=>{
      if(projectDomain.activeProject()?.source==='builtin')
        return map.loadPhysicalResources({includeHydro:true});
    }],
    onError:(error,stage)=>{
      diagnostics.push({category:'viewer-post-presentation',errorCode:'PL-VIEWER-POST-001',
        stage,technicalMessage:error?.message||String(error),stack:error?.stack||''});
      report(error,stage==='hydrate'?'검색 준비를 완료하지 못했습니다.':'지도 보조 정보를 갱신하지 못했습니다.','PL-VIEWER-POST-001');
    },
  });
  disposables.push(postPresentation);
  // Both imported files and the builtin map use the same C++ time cursor.
  const applyDocumentMonth=async(month,{isCurrent=()=>true,waitForFrame=false,admitPresentation=null,geometryPreparation}={})=>{
    projectDomain.requireTimelineMonth(month);
    const before=map.features(),generation=projectDomain.getGeneration();
    const previousMonth=activeSession.commandOwner.state().timelineCursor;
    await map.renderer.measureWork('core.timeline-cursor',()=>activeSession.commandOwner.setTimelineCursor(month,{isCurrent,geometryPreparation}));
    if(!isCurrent()||projectDomain.getGeneration()!==generation)return false;
    if(before!==map.features()&&territorialMembershipDelta(before,map.features()).changed)
      await map.objectCatalog.pruneLayerItemVisibility();
    if(!isCurrent()||projectDomain.getGeneration()!==generation)return false;
    // Country sources can tile while place data loads. Keep temporal admission
    // closed until both owners finish preparing the accepted Core month.
    await Promise.all([
      map.update({previousMonth}),
      waitForFrame&&map.viewState.layerVisibility.labels!==false
        ?owners.territorialLabels.preparePlaces():null,
    ]);
    if(!isCurrent()||projectDomain.getGeneration()!==generation)return false;
    if(admitPresentation?.()===false)return false;
    if(waitForFrame)await map.renderer.waitForMapPresentation(generation);
    if(!isCurrent()||projectDomain.getGeneration()!==generation)return false;
    search();syncStatus();
    return true;
  };
  const disposeTimeline=installTimelineControls({
    document,window,
    getMonth:()=>{
      const accepted=presentedMonth;
      return accepted&&(projectDomain.isOpening()||accepted.scope===projectDomain.activeProjectScope())
        ?accepted.month:activeSession?.commandOwner.state().timelineCursor||null;
    },
    getRange:()=>projectDomain.timelineNavigation().range,
    setMonth:async month=>{
      if(projectDomain.isOpening())throw new Error('지도를 여는 중입니다.');
      return projectClock.selectMonth(month);
    },
  });
  disposables.push({dispose:disposeTimeline});
  const open=async (reader,options)=>{
    postPresentation.invalidate();
    const searchTicket=searchController.beginProjectTransition?.();
    const preserved=options?.preserveView?map.capturePresentation():null;
    openingPreserved=preserved;
    const request=projectDomain.getOpenRevision()+1;
    const previouslyReady=status.dataset.ready==='true';
    // The prior dated map remains visible, but the requested new frame is
    // not ready until its generation has actually been presented. Keep the
    // existing presentation-commit and benchmark ordering intact.
    const retainingDatedFrame=options?.presentation==='temporal' && !!activeSession.commandOwner.state().timelineCursor;
    const firstMap=initialPresentation.track(()=>request===projectDomain.getOpenRevision()&&(options?.isCurrent?.()??true));
    status.dataset.loadingKind=initialPresentation.hasPresented()?(options?.presentation==='temporal'?'temporal':'project'):'initial';
    presentViewerLoadStatus(status,options?.presentation==='temporal'?'다음 시점 준비 중…':'지도 불러오는 중…');
    status.dataset.ready='false';
    try {
    if(!await projectDomain.open(reader,options)){
      firstMap.cancel();
      if(request===projectDomain.getOpenRevision()&&options?.isCurrent?.()!==false)
        status.dataset.ready=String(previouslyReady);
      return false;
    }
    if(request!==projectDomain.getOpenRevision()){firstMap.cancel();return false;}
    const presentedGeneration=projectDomain.getGeneration();
    firstMap.accept(presentedGeneration);
    // setSession already built the scene with the pruned viewing state.
    // Admit remaining Core/selection catalogs after the replacement transaction.
    await map.objectCatalog.pruneLayerItemVisibility();
    if(request!==projectDomain.getOpenRevision()||(options?.isCurrent?.()===false)
      ||projectDomain.getGeneration()!==presentedGeneration)return false;
    // Completion belongs to the actual current-generation bitmap/frame, not
    // the decoded document, a queued repaint or optional DEM completion.
    await map.renderer.waitForMapPresentation(presentedGeneration);
    if(request!==projectDomain.getOpenRevision()||(options?.isCurrent?.()===false)
      ||projectDomain.getGeneration()!==presentedGeneration)return false;
    presentedMonth={scope:projectDomain.activeProjectScope(),
      month:activeSession.commandOwner.state().timelineCursor};
    window.dispatchEvent(new CustomEvent('pandolab:project-changed'));
    status.dataset.ready='true';
    presentViewerLoadStatus(status,'지도 준비 완료.');
    postPresentation.schedule(()=>request===projectDomain.getOpenRevision()
      &&projectDomain.getGeneration()===presentedGeneration&&(options?.isCurrent?.()??true));
    return true;
    } catch(error){firstMap.cancel();if(request===projectDomain.getOpenRevision()){
      // A rejected source read or successfully rolled-back candidate still
      // leaves the previous dated map active. A failed restoration does not.
      status.dataset.ready=String(!error.restoreError
        &&(previouslyReady||retainingDatedFrame||initialPresentation.hasPresented()));
      if(error.code==='PL-GPU-UNAVAILABLE'){
        get('viewer').dataset.initialLoading='false';
        presentViewerLoadStatus(status,'WebGL2를 지원하는 브라우저와 GPU가 필요합니다.',{error:true});
      }else presentViewerLoadStatus(status,'지도를 불러오지 못했습니다.');
      throw error;
    }return false;}
    finally {
      // Search never owns map readiness: a failed optional refresh cannot
      // roll back an accepted frame. Tickets prevent an older read from
      // releasing another request's disabled result rows.
      if(searchTicket!=null)try{searchController.endProjectTransition?.(searchTicket);}
      catch(error){
        diagnostics.push({category:'viewer-membership-search',errorCode:'PL-VIEWER-MEMBERSHIP-001',
          technicalMessage:error?.message||String(error)});
      }
    }
  };
  const actionSubscriptions=[];
  let actionsDisposed=false;
  const action=(element,event,task)=>{
    if(!element)return;
    const handler=e=>{Promise.resolve().then(()=>{if(!actionsDisposed)return task(e);}).catch(report);};
    element.addEventListener(event,handler);
    actionSubscriptions.push(()=>element.removeEventListener(event,handler));
  };
  disposables.push({dispose(){
    actionsDisposed=true;
    for(const unsubscribe of actionSubscriptions.splice(0))unsubscribe();
  }});
  const changeProjectCursor=async(month,{isCurrent,commit})=>{
    projectDomain.requireTimelineMonth(month);
    const scope=projectDomain.activeProjectScope();
    const previous=presentedMonth?.scope===scope?presentedMonth.month:activeSession.commandOwner.state().timelineCursor;
    const current=()=>isCurrent()
      &&scope===projectDomain.activeProjectScope()&&!projectDomain.isOpening();
    const previouslyReady=presentedMonth?.scope===scope||status.dataset.ready==='true';
    let committed=false;
    const temporalTicket=map.renderer.beginTemporalViewTransition(current,()=>{committed=commit();});
    status.dataset.loadingKind='temporal';status.dataset.ready='false';
    presentViewerLoadStatus(status,'다음 시점 준비 중…');
    try{
      // Physical resources are scoped to this document; one C++ cursor owns
      // the date for both builtin and GeoPackage projects.
      let preparing=true;
      let geometryPreparation;
      const preparationCurrent=()=>preparing&&current();
      try{
        [,geometryPreparation]=await Promise.all([
          owners.physicalResources.preparePhysicalContext(month,{
            isCurrent:preparationCurrent,activeProject:projectDomain.activeProject()}),
          map.renderer.measureWork('core.timeline-geometry',()=>activeSession.commandOwner.prepareTimelineGeometry(month,{isCurrent:preparationCurrent})),
        ]);
      }finally{preparing=false;}
      if(!current())return false;
      // Keep the current map interactive while immutable physical data loads.
      // The existing frame guard is still needed once the cursor can change.
      map.renderer.preserveTemporalFrame();
      if(!await applyDocumentMonth(month,{isCurrent:current,waitForFrame:true,geometryPreparation,
        admitPresentation:()=>map.renderer.admitTemporalViewTransition(temporalTicket)}))return false;
      if(!current()||!committed)return false;
      status.dataset.ready='true';presentViewerLoadStatus(status,'지도 준비 완료.');
      postPresentation.schedule(current);
      return true;
    }catch(error){
      if(current()){
        if(previous){
          const restoreTicket=map.renderer.beginTemporalViewTransition(current);
          try{
            map.renderer.preserveTemporalFrame();
            map.renderer.retryMapPreparation();
            await owners.physicalResources.preparePhysicalContext(previous,{
              isCurrent:current,activeProject:projectDomain.activeProject()});
            if(!current())return false;
            // Do not report the prior map as restored merely because its C++
            // cursor was reset. Wait for that generation's real replacement
            // picture before releasing the date control's loading state.
            const restored=await applyDocumentMonth(previous,{isCurrent:current,waitForFrame:true,
              admitPresentation:()=>map.renderer.admitTemporalViewTransition(restoreTicket)});
            if(!restored)throw new Error('Previous dated map was not restored.');
          }catch(restoreError){error.restoreError=restoreError;}
          finally{map.renderer.finishTemporalViewTransition(restoreTicket);}
        }
        status.dataset.ready=String(previouslyReady&&!error.restoreError);
      }
      throw error;
    }finally{
      map.renderer.finishTemporalViewTransition(temporalTicket);
    }
  };
  projectClock=createProjectMonthClock({
    coalesceRequests:true,window,document,
    initialAutomatic:preferencePresentation.current.timeline.defaultWorldFollowCurrentMonth,
    canFollow:()=>!projectDomain.isOpening()
      &&(!projectDomain.activeProject()||projectDomain.activeProject().source==='builtin'),
    onFollowChange:(automatic,{mode})=>{
      // A file project's manual date does not alter default-world preferences.
      if(mode==='follow'||projectDomain.activeProject()?.source==='builtin'){
        const current=preferencePresentation.current;
        preferencePresentation.apply({...current,
          timeline:{...current.timeline,defaultWorldFollowCurrentMonth:automatic}},
          {rerender:false,reason:'default-world-follow'});
      }
    },
    applyMonth:async(month,{isCurrent,commit,mode})=>{
      const active=projectDomain.activeProject();
      if(mode==='startup'||(mode==='follow'&&active?.source!=='builtin')){
        // Returning from a GeoPackage reopens the manifest-backed project.
        const opened=await open(()=>map.prepareBuiltinProject(month,{isCurrent,transition:false}),{
          source:'builtin',isCurrent,presentation:'default'});
        return opened&&commit();
      }
      if(!active)return false;
      return changeProjectCursor(month,{isCurrent,commit});
    },
    onCommitted:()=>{
      presentedMonth={scope:projectDomain.activeProjectScope(),
        month:activeSession.commandOwner.state().timelineCursor};
      syncStatus();window.dispatchEvent(new CustomEvent('pandolab:project-changed'));
    },
    onError:report,
  });
  disposables.push(projectClock);
  display=createMapSettings({capabilities:owners.capabilities,viewPresentation:map});
  display.connect({
    layerResources:{loadHydroData:owners.physicalResources.loadHydroData,preparePlaces:owners.territorialLabels.preparePlaces},
    platform:{$:id=>get(id==='app'?'viewer':id),deepClone:structuredClone,clamp:(value,min,max)=>Math.max(min,Math.min(max,value))},
    navigation:map.navigation,domains:{renderingDomain:map.renderingDomain,objectSearchController:searchController},rendering:{mapRenderer:map.renderer},objectDisplay:map.objectCatalog,distributionPresentation:map.distributionPresentation,feedback:{reportOperationError:report},
    projectState:{get state(){return map.displayState();}},
    mapDisplayModel:{expandedMapDisplayGroups:map.objectPresentation.expandedMapDisplayGroups},territorialModel:{entityRepository:map.entityRepository},
    layerStyleServices:{layerStyle},applicationConstants:{DISTRIBUTION_RENDER_MODES},
    preferences:{saveUserPreferences,get userPreferences(){return preferencePresentation.current;},setUserPreferences:value=>{preferencePresentation.current=value;},renderPreferences:()=>preferencePresentation.apply(preferencePresentation.current,{persist:false})},
    hydroModel:owners.hydroSettings,
    workspaceUi:surfaces,
  });
  disposables.push(display);
  const navigationBindings=createNavigationBindings();
  navigationBindings.connect({platform:{$:get},workspaceUi:surfaces,surfaces,
    navigation:map.navigation,projectState:{state:map.viewState},objectPicking:map.objectPicking,
    projectPicker:{name:projectRuntime.project.name,openProject:()=>projectClock.followNow().catch(report)},
    readinessUi:notifications});
  navigationBindings.bindNavigationUI();
  disposables.push(navigationBindings);
  preferencesDialog=createPreferencesDialog({document,window,productMode,
    returnFocus:()=>get(surfaces.isMobile()?'mobileMenuBtn':'preferencesBtn'),
    getPreferences:()=>preferencePresentation.current,getMapState:()=>map.displayState(),mapSettings:display,
    applyPreferences:(value,options)=>preferencePresentation.apply(value,options),
    onError:report});
  disposables.push(preferencesDialog);
  const onProjectPreferences = () => preferencesDialog.sync();
  window.addEventListener('pandolab:project-changed', onProjectPreferences);
  disposables.push({ dispose: () => window.removeEventListener('pandolab:project-changed', onProjectPreferences) });
  if(inspectParams.get('debug')==='1')globalThis.__PANDOLAB_VIEWER__=Object.freeze({initialMapPresented:initialPresentation.hasPresented,productMode,documentState:()=>activeSession?.commandOwner.state(),
    documentSnapshot:()=>activeSession?.documentModel.snapshot(),resolvedWorld:()=>activeSession?.documentModel.world(),selectionSnapshot:()=>activeSession?.selectionDomain.snapshot().selection,
    diagnostics:diagnostics.snapshot,rendererStats:()=>map.renderer.getStats(),previewExternalBasemap:style=>map.renderer.previewExternalBasemap(style),
    visibleTerritorialCount:()=>map.objectQuery.visibleTerritorialCount(),
    mapProjection:()=>map.viewState.projection,readOnly:documentSession.readOnly,
    builtinMonth:()=>({
      month:activeSession.commandOwner.state().timelineCursor,
      automatic:projectClock.isAutomatic()&&projectDomain.activeProject()?.source==='builtin'})});
  }
  const lifecycle=createApplicationLifecycle({window,document,
    // Only initial engine admission is safe to repeat. DOM/map composition is not.
    compose:[()=>documentSession.commandOwner.load(JSON.stringify(documentSession.documentModel.snapshot())),composeMap],
    startup:async()=>{
      // Source admission can start immediately. The accepted scene still
      // waits for map.ready in the map owner before it can be submitted.
      const rendererReady=map.ready.catch(error=>{
        projectClock.cancelPending();
        throw error;
      });
      const [,accepted]=await Promise.all([rendererReady,projectClock.initialize()]);
      return accepted;
    },
    shouldRetryCompose:(error,index)=>index===0&&isRecoverableLoadError(error),
    shouldRetryStartup:isRecoverableLoadError,
    getDisposables:()=>[...disposables].reverse(),
    onRecoverableError:(error,{retry})=>{
      console.warn('[PL-MAP-START-RETRY]',error);
      status.dataset.ready='false';
      presentViewerLoadStatus(status,'연결이 복구되면 지도를 다시 불러옵니다. ',{error:true});
      const button=document.createElement('button');button.type='button';button.className='ui-button btn';button.textContent='다시 시도';
      button.addEventListener('click',()=>{retry().catch(report);});status.appendChild(button);
    },
    onError:error=>{
      get('viewer').dataset.initialLoading='false';
      const unsupported=map?.renderer.getRuntimeState().renderer==='failed';
      presentViewerLoadStatus(status,unsupported?'WebGL2를 지원하는 브라우저와 GPU가 필요합니다.':'지도를 불러오지 못했습니다. 새로고침해 다시 시도하세요.',{error:true});
      report(error,'지도를 불러오지 못했습니다.','PL-MAP-START');
    },reportDisposeError:error=>console.error('[PL-DISPOSE]',error)});
  await lifecycle.start();
  preferencesDialog.sync();
  await inspectorController?.openAfterStartup();
}
