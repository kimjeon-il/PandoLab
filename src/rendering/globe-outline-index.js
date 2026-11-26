function indexOwners(owners) {
  const groupsBySlot = new Map();
  owners.forEach((slots, group) => {
    for (const slot of slots) {
      let groups = groupsBySlot.get(slot);
      if (!groups) {groups = []; groupsBySlot.set(slot, groups);}
      groups.push(group);
    }
  });
  return groupsBySlot;
}
export function indexGlobeOutlineRanges(packet, owners) {
  const groupsBySlot = indexOwners(owners), rangesByGroup = Array.from({length:owners.length}, () => []);
  for (let first = 0; first<packet.count;) {
    const group = packet.ownerGroups[first];
    let end = first+1;
    while (end<packet.count&&packet.ownerGroups[end]===group)end++;
    rangesByGroup[group].push([first, end]); first = end;
  }
  return {groupsBySlot, rangesByGroup};
}
export function selectGlobeOutlineGroups(index, roles, styles) {
  const groups = new Map();
  for (const [slot, code] of roles) {
    const style = styles[code];
    if (!style||style.width<=0||style.alpha<=0)continue;
    for (const group of index.groupsBySlot.get(slot)??[]) {
      if (code>(groups.get(group)??0))groups.set(group, code);
    }
  }
  return groups;
}
export function globeOutlineRanges(index, groups) {
  return [...groups].flatMap(([group, code]) => index.rangesByGroup[group].map(([first, end]) => ({first, end, code})))
    .sort((a, b) => a.first-b.first);
}

// One immutable reverse index: changing one owner group visits only its
// affected chunks, even for a base packet spanning the entire world.
export function indexGlobeOutlineChunks(packet, owners) {
  const groupsBySlot = indexOwners(owners);
  const chunksByGroup = Array.from({length:owners.length}, () => []);
  let metadataBytes = owners.reduce((sum, slots) => sum+slots.length*8, 0)+owners.length*24;
  packet.spatialParts.forEach(({packet:part}, chunkId) => {
    const groups = new Map();
    for (let first = 0; first<part.count;) {
      const group = part.ownerGroups[first];
      let end = first+1; while (end<part.count&&part.ownerGroups[end]===group)end++;
      let row = groups.get(group);
      if (!row) {row = {chunkId, count:0, ranges:[]}; groups.set(group, row); chunksByGroup[group].push(row); metadataBytes+=48;}
      row.count+=end-first; row.ranges.push([first, end]); metadataBytes+=32; first = end;
    }
  });
  return {groupsBySlot, chunksByGroup, metadataBytes};
}
