import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {defaultUserPreferences,normalizeUserPreferences,loadUserPreferences,saveUserPreferences,effectiveTheme,STORAGE_KEY} from '../../../src/ui/user-preferences.js';
import {resolveMapPalette} from '../../../src/ui/map-palette.js';

test('white map palette is independent of application appearance',()=>{
 const base=resolveMapPalette({state:{layerPresentation:{styles:{objects:{boundaryVisible:true}}}}});
 assert.equal(base.defaultLand,'#f1f1f1');
 assert.equal(base.ocean,'#ffffff');
 assert.equal(base.border,'#515151');
 assert.equal(base.baseLandAlpha,1);
 assert.equal(base.loadingSurface.land,'#f1f1f1');
 assert.equal(defaultUserPreferences().appearance.theme,'system');
 assert.equal(normalizeUserPreferences({version:2,appearance:{theme:'dark'}}).appearance.theme,'dark');
});
test('preferences round-trip retains current settings without rewriting on load',()=>{
 let writes=0;
 const source={version:2,appearance:{theme:'dark',smoothLines:false},
  selection:{color:'#ff2255',outlineVisible:false,fillStrength:0.62},
  labels:{country:{font:'serif',color:'#112233'},place:{font:'gothic',showNativeNames:true}},
  backgrounds:{viewer:{graticule:false}},timeline:{defaultWorldFollowCurrentMonth:false}};
 const storage={value:JSON.stringify(source),getItem(key){assert.equal(key,STORAGE_KEY);return this.value;},
  setItem(key,value){assert.equal(key,STORAGE_KEY);writes++;this.value=value;}};
 const loaded=loadUserPreferences(storage);
 assert.equal(writes,0);
 assert.equal(loaded.appearance.theme,'dark');
 assert.equal(loaded.appearance.smoothLines,false);
 assert.equal(loaded.selection.color,'#ff2255');
 assert.equal(loaded.selection.outlineVisible,false);
 assert.equal(loaded.selection.fillStrength,0.62);
 assert.equal(loaded.labels.country.font,'serif');
 assert.equal(loaded.labels.place.showNativeNames,true);
 assert.equal(loaded.backgrounds.viewer.graticule,false);
 assert.equal(loaded.timeline.defaultWorldFollowCurrentMonth,false);
 assert.deepEqual(loadUserPreferences(storage),loaded);
 assert.equal(writes,0);
 assert.deepEqual(saveUserPreferences(loaded,storage),loaded);
 assert.equal(writes,1);
});
test('malformed preferences resolve to the current shape',()=>{
 assert.equal(normalizeUserPreferences(null).appearance.theme,'system');
 assert.equal(loadUserPreferences({getItem:()=>'{bad json'}).appearance.smoothLines,true);
 assert.equal(effectiveTheme({version:2,appearance:{theme:'system'}},true),'dark');
});
test('early HTML chooses only the application color scheme',()=>{
 const html=readFileSync(new URL('../../../src/app/index.html',import.meta.url),'utf8');
 const script=html.match(/<script>(\(function\(\)\{try\{var p=JSON\.parse[\s\S]*?\}\(\)\);)<\/script>/)?.[1];
 assert.ok(script);
 const document={documentElement:{dataset:{}}};
 const context={document,localStorage:{getItem:()=>JSON.stringify({version:2,appearance:{theme:'dark'}})},
  window:{matchMedia:()=>({matches:false})}};
 runInNewContext(script,context);
 assert.equal(document.documentElement.dataset.theme,'dark');
});
