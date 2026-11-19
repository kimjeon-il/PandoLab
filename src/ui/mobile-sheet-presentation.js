import { isMobileWorkspaceLayout } from './workspace-layout.js';

/** Shared mobile sheet sizing and pointer/keyboard gestures; the host owns which surface is open. */
export function createMobileSheetPresentation({document,window,getElement,getLayout,panelIds:MOBILE_SHEET_IDS,onSync,onClose,onResumeLayout,onLayoutChange}) {
  const SHEET_SNAP_RATIOS = Object.freeze([0, 0.52, 0.88]);
  const SHEET_SNAP_LABELS = Object.freeze(['접힌 상태', '중간 높이', '확장']);
  const MOBILE_SHEET_DEFAULT_SNAP = 0;
  const sheetSnapIndex=new Map(Object.values(MOBILE_SHEET_IDS).map(id=>[id,MOBILE_SHEET_DEFAULT_SNAP]));
  const mobileSheetSettlement=new Map();
  let activeSheetDrag=null;
  const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
  const isMobile=()=>isMobileWorkspaceLayout(getLayout());
  const mobileViewportHeight=()=>window.visualViewport?.height||window.innerHeight;
  function mobileSheetSnapHeight(index, panel) {
    const safeIndex = clamp(Number(index) || 0, 0, SHEET_SNAP_RATIOS.length - 1);
    const availableHeight = Number.parseFloat(getComputedStyle(panel).maxHeight) || mobileViewportHeight();
    if (safeIndex === 0) return document.getElementById('timelineControls').getBoundingClientRect().height;
    return Math.max(mobileSheetSnapHeight(0, panel), Math.min(availableHeight, mobileViewportHeight() * SHEET_SNAP_RATIOS[safeIndex]));
  }

  function mobileSheetPanel(kind) {
    return getElement(MOBILE_SHEET_IDS[kind]);
  }

  function setMobileSheetHeight(panel, index, temporaryHeight = null) {
    if (!panel) return 0;
    const safeIndex = clamp(Number(index) || 0, 0, SHEET_SNAP_RATIOS.length - 1);
    const maxHeight = mobileSheetSnapHeight(SHEET_SNAP_RATIOS.length - 1, panel);
    const minHeight = mobileSheetSnapHeight(0, panel);
    const height = temporaryHeight == null
      ? mobileSheetSnapHeight(safeIndex, panel)
      : clamp(temporaryHeight, minHeight, maxHeight);
    panel.style.setProperty('--sheet-height', `${Math.round(height)}px`);
    if (temporaryHeight == null) {
      sheetSnapIndex.set(panel.id, safeIndex);
      panel.dataset.sheetSnap = String(safeIndex);
      const handle = panel.querySelector('[data-sheet-handle]');
      handle?.setAttribute('aria-valuenow', String(safeIndex));
      handle?.setAttribute('aria-valuetext', SHEET_SNAP_LABELS[safeIndex]);
    }
    return height;
  }

  function resetMobileSheetSession(panel, { applyHeight = true } = {}) {
    if (!panel) return;
    sheetSnapIndex.set(panel.id, MOBILE_SHEET_DEFAULT_SNAP);
    if (applyHeight) setMobileSheetHeight(panel, MOBILE_SHEET_DEFAULT_SNAP);
  }

  function nearestSheetSnapIndex(height, panel) {
    let nearest = 0;
    let distance = Infinity;
    SHEET_SNAP_RATIOS.forEach((_, index) => {
      const nextDistance = Math.abs(height - mobileSheetSnapHeight(index, panel));
      if (nextDistance < distance) {
        distance = nextDistance;
        nearest = index;
      }
    });
    return nearest;
  }

  function clearMobileSheetDragPresentation(panel) {
    if (!panel) return;
    const pending = mobileSheetSettlement.get(panel);
    if (pending?.timer) clearTimeout(pending.timer);
    mobileSheetSettlement.delete(panel);
    panel.classList.remove('is-sheet-dragging', 'is-sheet-settling');
    panel.style.removeProperty('--sheet-drag-height');
    panel.style.removeProperty('--sheet-drag-offset');
  }

  function applyMobileSheetDragPreview(panel, height) {
    const maxHeight = mobileSheetSnapHeight(SHEET_SNAP_RATIOS.length - 1, panel);
    const minHeight = mobileSheetSnapHeight(0, panel);
    const visibleHeight = clamp(Number(height) || 0, minHeight, maxHeight);
    panel.style.setProperty('--sheet-drag-height', `${Math.round(maxHeight)}px`);
    panel.style.setProperty('--sheet-drag-offset', `${Math.round(maxHeight - visibleHeight)}px`);
    return { visibleHeight, maxHeight };
  }

  function finalizeMobileSheetSettlement(panel) {
    const settlement = mobileSheetSettlement.get(panel);
    if (!settlement) return false;
    if (settlement.timer) clearTimeout(settlement.timer);
    mobileSheetSettlement.delete(panel);
    const { dismiss, restoreFocus } = settlement;
    const resumeLayout = onResumeLayout;
    panel.classList.remove('is-sheet-dragging', 'is-sheet-settling');
    panel.style.removeProperty('--sheet-drag-height');
    panel.style.removeProperty('--sheet-drag-offset');
    if (dismiss) {
      onClose({ restoreFocus });
      resumeLayout();
      return true;
    }
    resumeLayout();
    onSync();

    onLayoutChange();
    return true;
  }

  function settleMobileSheetDrag(panel, { targetIndex = null, dismiss = false, restoreFocus = false } = {}) {
    if (!panel) return;
    const previous = mobileSheetSettlement.get(panel);
    if (previous?.timer) clearTimeout(previous.timer);
    const maxHeight = mobileSheetSnapHeight(SHEET_SNAP_RATIOS.length - 1, panel);
    let targetOffset = maxHeight;
    if (!dismiss) {
      const safeTarget = clamp(Number(targetIndex) || 0, 0, SHEET_SNAP_RATIOS.length - 1);
      const targetHeight = setMobileSheetHeight(panel, safeTarget);
      targetOffset = Math.max(0, maxHeight - targetHeight);
    }
    const settlement = { dismiss, restoreFocus, timer: 0 };
    mobileSheetSettlement.set(panel, settlement);
    panel.classList.remove('is-sheet-dragging');
    panel.classList.add('is-sheet-settling');
    panel.style.setProperty('--sheet-drag-height', `${Math.round(maxHeight)}px`);
    requestAnimationFrame(() => {
      if (mobileSheetSettlement.get(panel) !== settlement) return;
      panel.style.setProperty('--sheet-drag-offset', `${Math.round(targetOffset)}px`);
    });
    settlement.timer = setTimeout(() => finalizeMobileSheetSettlement(panel), 280);
  }

  function beginMobileSheetDrag(panel, source, pointerId, clientY) {
    if (!isMobile() || !panel || activeSheetDrag) return false;
    clearMobileSheetDragPresentation(panel);
    const currentHeight = Number.parseFloat(getComputedStyle(panel).height)
      || setMobileSheetHeight(panel, sheetSnapIndex.get(panel.id) ?? MOBILE_SHEET_DEFAULT_SNAP);
    activeSheetDrag = {
      panel,
      source,
      pointerId,
      startY: clientY,
      startHeight: currentHeight,
      previewHeight: currentHeight,
      startIndex: sheetSnapIndex.get(panel.id) ?? MOBILE_SHEET_DEFAULT_SNAP,
      startTime: performance.now(),
      moved: false,
    };
    return true;
  }

  function moveMobileSheetDrag(panel, source, pointerId, clientY) {
    const drag = activeSheetDrag;
    if (!drag || drag.panel !== panel || drag.source !== source || drag.pointerId !== pointerId) return false;
    const deltaY = clientY - drag.startY;
    if (!drag.moved) {
      if (Math.abs(deltaY) <= 6) return true;
      drag.moved = true;
      panel.classList.add('is-sheet-dragging');
      document.body.classList.add('map-sheet-dragging');
    }
    const preview = applyMobileSheetDragPreview(panel, drag.startHeight - deltaY);
    drag.previewHeight = preview.visibleHeight;
    return true;
  }

  function finishMobileSheetDrag(panel, source, pointerId, clientY, { cancelled = false } = {}) {
    const drag = activeSheetDrag;
    if (!drag || drag.panel !== panel || drag.source !== source || drag.pointerId !== pointerId) return null;
    const deltaY = clientY - drag.startY;
    const currentHeight = Number(drag.previewHeight || drag.startHeight);
    const elapsed = Math.max(1, performance.now() - drag.startTime);
    const velocity = deltaY / elapsed;
    activeSheetDrag = null;
    if (!drag.moved) {
      onResumeLayout();
      return drag;
    }
    document.body.classList.remove('map-sheet-dragging');
    const dismissDistance = Math.min(180, drag.startHeight * 0.3);
    if (!cancelled && deltaY > 64 && (deltaY >= dismissDistance || velocity > 0.65)) {
      settleMobileSheetDrag(panel, { dismiss: true, restoreFocus: true });
    } else {
      let targetIndex = cancelled ? drag.startIndex : nearestSheetSnapIndex(currentHeight, panel);
      if (!cancelled && drag.moved && Math.abs(deltaY) > 24 && Math.abs(velocity) > 0.45) {
        targetIndex = clamp(drag.startIndex + (deltaY < 0 ? 1 : -1), 0, SHEET_SNAP_RATIOS.length - 1);
      }
      settleMobileSheetDrag(panel, { targetIndex });
    }
    return drag;
  }

  function bindSheetDragHandle(handle) {
    const panel = getElement(handle?.dataset?.sheetHandle);
    if (!handle || !panel) return;
    handle.addEventListener('click', event => {
      if (!isMobile()) return;
      if (handle.dataset.dragged === 'true') {
        handle.dataset.dragged = 'false';
        event.preventDefault();
        return;
      }
      const current = sheetSnapIndex.get(panel.id) ?? MOBILE_SHEET_DEFAULT_SNAP;
      const target = current === SHEET_SNAP_RATIOS.length - 1 ? 0 : SHEET_SNAP_RATIOS.length - 1;
      setMobileSheetHeight(panel, target);
      onSync();
    });
    handle.addEventListener('keydown', event => {
      if (!isMobile()) return;
      const current = sheetSnapIndex.get(panel.id) ?? MOBILE_SHEET_DEFAULT_SNAP;
      let target;
      if (event.key === 'ArrowUp' || event.key === 'PageUp') target = Math.min(SHEET_SNAP_RATIOS.length - 1, current + 1);
      else if (event.key === 'ArrowDown' || event.key === 'PageDown') target = Math.max(0, current - 1);
      else if (event.key === 'Home') target = 0;
      else if (event.key === 'End') target = SHEET_SNAP_RATIOS.length - 1;
      else if (event.key === 'Escape') {
        onClose({ restoreFocus: true });
        event.preventDefault();
        return;
      } else return;
      setMobileSheetHeight(panel, target);
      onSync();
      event.preventDefault();
    });
    handle.addEventListener('pointerdown', event => {
      if (!isMobile() || event.button > 0) return;
      if (!beginMobileSheetDrag(panel, handle, event.pointerId, event.clientY)) return;
      try { handle.setPointerCapture?.(event.pointerId); } catch (_) {}
      event.preventDefault();
    });
    handle.addEventListener('pointermove', event => {
      if (moveMobileSheetDrag(panel, handle, event.pointerId, event.clientY)) event.preventDefault();
    });
    const finish = (event, cancelled = false) => {
      const drag = finishMobileSheetDrag(panel, handle, event.pointerId, event.clientY, { cancelled });
      if (!drag) return;
      handle.dataset.dragged = String(drag.moved);
      try { handle.releasePointerCapture?.(event.pointerId); } catch (_) {}
    };
    handle.addEventListener('pointerup', event => finish(event));
    handle.addEventListener('pointercancel', event => finish(event, true));
  }

  function bindMobileSheetSurface(panel) {
    if (!panel) return;
    const header = panel.querySelector('.surface-header');
    const handle = panel.querySelector('[data-sheet-handle]');
    if (handle) bindSheetDragHandle(handle);

    if (header) {
      header.addEventListener('pointerdown', event => {
        if (!isMobile() || event.button > 0 || event.target.closest('[data-sheet-handle], button, input, textarea, select')) return;
        if (!beginMobileSheetDrag(panel, header, event.pointerId, event.clientY)) return;
        try { header.setPointerCapture?.(event.pointerId); } catch (_) {}
        event.preventDefault();
      });
      header.addEventListener('pointermove', event => {
        if (moveMobileSheetDrag(panel, header, event.pointerId, event.clientY)) event.preventDefault();
      });
      const finishHeader = (event, cancelled = false) => {
        const drag = finishMobileSheetDrag(panel, header, event.pointerId, event.clientY, { cancelled });
        if (!drag) return;
        try { header.releasePointerCapture?.(event.pointerId); } catch (_) {}
      };
      header.addEventListener('pointerup', event => finishHeader(event));
      header.addEventListener('pointercancel', event => finishHeader(event, true));
    }
    panel.addEventListener('transitionend', event => {
      if (event.target !== panel || !['height', 'width', 'transform'].includes(event.propertyName)) return;
      if (getLayout() !== 'wide') onLayoutChange();
    });
  }
  return Object.freeze({mobileSheetPanel,setMobileSheetHeight,resetMobileSheetSession,clearMobileSheetDragPresentation,bindMobileSheetSurface,
    get activeDrag(){return activeSheetDrag;},get settling(){return mobileSheetSettlement.size>0;},snapIndex:sheetSnapIndex,
    dispose(){for(const panel of mobileSheetSettlement.keys())clearMobileSheetDragPresentation(panel);},
  });
}
