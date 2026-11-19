export const HYDRO_CATEGORY_STYLES = Object.freeze({
      river: Object.freeze({ geometry: 'LineString', category: 'river', label: '강', color: '#3b82c4', prefix: 'river' }),
      lake: Object.freeze({ geometry: 'Polygon', category: 'lake', label: '호수', color: '#5aa9d6', prefix: 'lake' }),
    });

export const HYDRO_LAYER_META = Object.freeze({
      rivers_hydro: Object.freeze({ label: '강', shortLabel: '강', sourceLabel: 'HydroRIVERS', category: 'river', color: '#3b82c4' }),
      lakes_natural_earth: Object.freeze({ label: '호수', shortLabel: '호수', sourceLabel: 'Natural Earth', category: 'lake', color: '#5aa9d6' }),
    });


export const PHYSICAL_DATASET='HydroRIVERS 1.0 · Natural Earth 5.0.0 호수';

/** The canonical land/hydro resources share a stable data root. */
export function createPhysicalSourceConfiguration({assetBaseUrl,mapProject}={}){
 if(!mapProject)throw new Error('프로젝트 지형 카탈로그가 필요합니다.');
 return Object.freeze({PHYSICAL_DATA_BASE_URL:new URL('../data/',assetBaseUrl)});
}
