/** Route MapLibre camera gestures and geographic hits into existing Core selection. */
export function createMapLibreInputPresentation({renderer,initialized,ports}){
 let disposed=false,map=null;
 const listeners=[];
 const report=error=>ports.feedback.reportOperationError(error,'지도 입력을 적용하지 못했습니다.','PL-MAP-INPUT-001',4200);
 const beginMovement=()=>{ports.projectState.state.mapMoving=true;ports.renderQuality.renderQualityController.beginInteraction('maplibre-move');ports.projectState.mapWorkScheduler.setInteractionActive(true);ports.pointerInteraction.cancelCountryHoverPick({clear:true}).catch(report);};
 const finishMovement=()=>{ports.projectState.state.mapMoving=false;ports.renderQuality.renderQualityController.endInteraction('maplibre-move');ports.renderQuality.applyAdaptiveRenderQuality({refreshScene:false,reason:'maplibre-move-end'});ports.projectState.mapWorkScheduler.setInteractionActive(false);};
 function listen(type,callback){map.on(type,callback);listeners.push(()=>map.off(type,callback));}
 function bindMapEvents(){initialized.then(()=>{
  if(disposed)return;map=renderer.map;
  const container=map.getCanvasContainer();
  const blockReplacementInput=event=>{
   if(!ports.projectState.state.projectReplacing)return;
   if(event.type==='keydown'&&!/^(Arrow|Page|Home|End)|^[+\-=]$/.test(event.key))return;
   event.preventDefault();event.stopImmediatePropagation();
  };
  for(const type of ['pointerdown','mousedown','touchstart','wheel','dblclick','keydown']){
   container.addEventListener(type,blockReplacementInput,{capture:true,passive:false});
   listeners.push(()=>container.removeEventListener(type,blockReplacementInput,true));
  }
  listen('movestart',beginMovement);listen('moveend',finishMovement);
  listen('click',event=>{
   if(renderer.isFramePreserved()||ports.projectState.state.projectReplacing||ports.pointerInteraction.mapClickBlocked())return;
   ports.objectPicking.handleObjectSelectionAt([event.point.x,event.point.y],{sourceEvent:event.originalEvent}).catch(report);
  });
  listen('mousemove',event=>{if(renderer.isFramePreserved()||ports.surfaces.isMobile()||ports.projectState.state.projectReplacing)return;
   const point=[event.point.x,event.point.y],coordinate=renderer.projection.screenToGeo(point);
   if(coordinate)ports.pointerInteraction.queueCountryHoverPick(point,coordinate);else ports.pointerInteraction.cancelCountryHoverPick({clear:true}).catch(report);
  });
  listen('mouseout',()=>ports.pointerInteraction.cancelCountryHoverPick({clear:true}).catch(report));
 }).catch(report);}
 return Object.freeze({bindMapEvents,beginMovement,finishMovement,dispose(){disposed=true;listeners.forEach(remove=>remove());ports.pointerInteraction.cancelCountryHoverPick({clear:true}).catch(report);}});
}
