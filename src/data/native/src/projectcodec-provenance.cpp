#include "projectcodec-detail.h"
#include <pandoeditor/geometryprovenance.h>
#include <set>

namespace pandoeditor {
void GeometryProvenanceCodecAccess::admitPresentationMetadata(const ProjectDocument& before, ProjectDocument& candidate) {
    if (before.exchangeMetadata==candidate.exchangeMetadata||before.geometryProvenance.opaqueUncertain)return;
    auto previous = codecjson::parse(before.exchangeMetadata), next = codecjson::parse(candidate.exchangeMetadata);
    codecjson::require(previous.encode()==next.encode(),"INVALID_GEOMETRY_PROVENANCE: non-presentation header changed");
    candidate.geometryProvenance.opaqueBaseline["/exchangeMetadata"] = projectcodec::codec_detail::opaqueSha256(candidate.exchangeMetadata);
    sealVerifiedOpaqueBaseline(candidate);
}
void GeometryProvenanceCodecAccess::admitPhysicalViewMetadata(const ProjectDocument& before, ProjectDocument& candidate) {
    if (before.exchangeMetadata==candidate.exchangeMetadata||before.geometryProvenance.opaqueUncertain)return;
    auto previous = codecjson::parse(before.exchangeMetadata), next = codecjson::parse(candidate.exchangeMetadata);
    const auto withoutViewSettings = [](codecjson::Value& header) {
        auto physical = header.object.find("physicalSettings");
        if (physical==header.object.end())return;
        codecjson::require(physical->second.kind==codecjson::Value::Object,
                           "INVALID_GEOMETRY_PROVENANCE: physical settings must be an object");
        for (const auto* key:{"terrainVisible","terrainStyle","hydroLayers","hiddenHydroIds"})
            physical->second.object.erase(key);
        if (physical->second.object.empty())header.object.erase(physical);
    };
    withoutViewSettings(previous); withoutViewSettings(next);
    codecjson::require(previous.encode()==next.encode(),
                       "INVALID_GEOMETRY_PROVENANCE: unrelated physical metadata changed");
    // View rebasing cannot modify opaque geometry/source annotations.
    auto oldSlots = geometryProvenanceOpaqueSlots(before);
    auto newSlots = geometryProvenanceOpaqueSlots(candidate);
    oldSlots.erase("/exchangeMetadata"); newSlots.erase("/exchangeMetadata");
    codecjson::require(oldSlots==newSlots,
                       "INVALID_GEOMETRY_PROVENANCE: unrelated opaque dependency changed");
    candidate.geometryProvenance.opaqueBaseline["/exchangeMetadata"] = projectcodec::codec_detail::opaqueSha256(candidate.exchangeMetadata);
    sealVerifiedOpaqueBaseline(candidate);
}
void GeometryProvenanceCodecAccess::admitProjectSetupMetadata(const ProjectDocument& before, ProjectDocument& candidate) {
    if (before.geometryProvenance.opaqueUncertain)return;
    auto previous = codecjson::parse(before.exchangeMetadata), next = codecjson::parse(candidate.exchangeMetadata);
    previous.object.erase("projectSetup"); next.object.erase("projectSetup");
    codecjson::require(previous.encode()==next.encode(),"INVALID_GEOMETRY_PROVENANCE: unrelated project header changed");
    const auto oldSlots = geometryProvenanceOpaqueSlots(before), newSlots = geometryProvenanceOpaqueSlots(candidate);
    codecjson::require(oldSlots.size()==newSlots.size(),"INVALID_GEOMETRY_PROVENANCE: project dependencies changed");
    for (const auto& [path, value]:newSlots)if (path!="/exchangeMetadata") {
        const auto old = oldSlots.find(path); codecjson::require(old!=oldSlots.end()&&old->second==value,"INVALID_GEOMETRY_PROVENANCE: project dependency changed");
    }
    candidate.geometryProvenance.opaqueUncertain = false; candidate.geometryProvenance.opaqueBaseline["/exchangeMetadata"] = projectcodec::codec_detail::opaqueSha256(candidate.exchangeMetadata); sealVerifiedOpaqueBaseline(candidate);
}
void GeometryProvenanceCodecAccess::admitSourceInfoMetadata(const ProjectDocument& before, ProjectDocument& candidate) {
    if (before.geometryProvenance.opaqueUncertain)return;
    auto previous = codecjson::parse(before.exchangeMetadata), next = codecjson::parse(candidate.exchangeMetadata);
    previous.object.erase("sourceInfo"); next.object.erase("sourceInfo");
    codecjson::require(previous.encode()==next.encode(),"INVALID_GEOMETRY_PROVENANCE: unrelated source header changed");
    const auto oldSlots = geometryProvenanceOpaqueSlots(before), newSlots = geometryProvenanceOpaqueSlots(candidate);
    for (const auto& [path, value]:newSlots)if (path!="/exchangeMetadata") {
        const auto old = oldSlots.find(path); codecjson::require(old!=oldSlots.end()&&old->second==value,"INVALID_GEOMETRY_PROVENANCE: unrelated source dependency changed");
    }
    candidate.geometryProvenance.opaqueUncertain = false;
    candidate.geometryProvenance.opaqueBaseline["/exchangeMetadata"] = projectcodec::codec_detail::opaqueSha256(candidate.exchangeMetadata);
    sealVerifiedOpaqueBaseline(candidate);
}
void GeometryProvenanceCodecAccess::admitCreatedOpaqueBaseline(const ProjectDocument& before, ProjectDocument& candidate,
                                                             const std::set<ObjectRef>& createdOwners) {
    if (createdOwners.empty()||before.geometryProvenance.opaqueUncertain)return;
    std::set<ObjectRef> existing;
    const auto collect = [&](const char* domain, const auto& rows) {for (const auto& row:rows)existing.insert({domain, row.id});};
    collect("territorial", before.units); collect("label", before.labels); collect("hydro", before.hydro);
    collect("generic", before.genericFeatures); collect("distributionLayer", before.distributionLayers); collect("distributionEntry", before.distributionEntries);
    std::set<std::string> allowed;
    for (const auto& owner:createdOwners) {
        codecjson::require(!existing.count(owner),"INVALID_GEOMETRY_PROVENANCE: creation owner already exists");
        const char* path = owner.domain=="label"?"/labels":owner.domain=="hydro"?"/hydro":owner.domain=="generic"?"/genericFeatures":
            owner.domain=="distributionLayer"?"/distributionLayers":owner.domain=="distributionEntry"?"/distributionEntries":owner.domain=="territorial"?"/units":nullptr;
        codecjson::require(path,"INVALID_GEOMETRY_PROVENANCE: unsupported creation owner");
        allowed.insert(projectcodec::codec_detail::pointer(path, owner.id)+(owner.domain=="label"||owner.domain=="hydro"||owner.domain=="generic"?"/source/details":"/metadata"));
        if (owner.domain=="label")allowed.insert(projectcodec::codec_detail::pointer(path, owner.id)+"/metadata");
        if (owner.domain=="hydro")allowed.insert(projectcodec::codec_detail::pointer(path, owner.id)+"/properties");
    }
    const auto oldSlots = geometryProvenanceOpaqueSlots(before), newSlots = geometryProvenanceOpaqueSlots(candidate);
    auto baseline = before.geometryProvenance.opaqueBaseline;
    for (const auto& [path, value]:newSlots) {
        const auto old = oldSlots.find(path);
        if (old!=oldSlots.end()) {if (old->second!=value)return;}
        else {if (!allowed.count(path))return; baseline[path] = projectcodec::codec_detail::opaqueSha256(value);}
    }
    candidate.geometryProvenance.opaqueUncertain = false;
    candidate.geometryProvenance.opaqueBaseline = std::move(baseline);
    sealVerifiedOpaqueBaseline(candidate);
}
}
