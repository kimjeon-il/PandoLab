import test from 'node:test';
import assert from 'node:assert/strict';
import {recordBuiltinWorldInputs,buildBuiltinWorldPartialPublication} from '../../tools/build/build-builtin-world.mjs';

test('scoped country generation follows simultaneous versions and explicit parent dependencies',()=>{
  const source=(entityId,validFrom,validTo,periods=[{validFrom,validTo}])=>({
    entityId,sha256:entityId,parentEntityId:'',lifetime:periods.length===1?periods[0]:periods,
    bbox:[0,0,2,2],geometryVersions:[{versionId:entityId+':geometry',validFrom,validTo}],
  });
  const entities=[
    source('state:NEW','2000-01-01',null),
    source('state:EXPIRED','1900','1999'),
    source('state:OVERLAP','2000','2000-01'),
    source('state:GAP','1990','2010',[{validFrom:'1990',validTo:'1999'}, {validFrom:'2001',validTo:'2010'}]),
    source('state:PARENT','1900','2010'),
  ];
  entities[0].geometryVersions[0].validTo='2000-12-31';
  entities[4].bbox=[10,10,12,12];
  const view={schemaVersion:1,selections:[{entityId:'state:NEW',geometryVersionId:'state:NEW:geometry'}]};
  const policy={schemaVersion:1,replacements:[],parentRelations:[{
    entityId:'state:NEW',parentEntityId:'state:PARENT',validFrom:'2000-03',validTo:'2000-04',
  }]};
  const sourceIndex={entities};
  const previousIndex={sourceIdentities:entities.map(({entityId})=>({
    projectEntityId:entityId,sourceEntityIds:[entityId],sourceFeatureIds:[],
  }))};
  recordBuiltinWorldInputs(previousIndex,Object.fromEntries(entities.map(e=>[e.entityId,e.sha256])),view,policy);
  const plan=buildBuiltinWorldPartialPublication({
    entityIds:['state:NEW'],sourceIndex,previousSourceIndex:sourceIndex,view,policy,previousIndex,
    previousCoverage:{adjustments:[]},displayPolicy:{subunits:[]},planOnly:true,
    readSource(){assert.fail('metadata-only plan read a coordinate payload');},
  });
  assert.deepEqual(plan.sourceIds.sort(),['state:NEW','state:OVERLAP','state:PARENT']);
});
