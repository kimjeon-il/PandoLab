#include <pandoeditor/commands.h>
#include <pandoeditor/losslessjson.h>
#include <pandoeditor/projectcodec.h>
#include <pandoeditor/project.h>
#include <pandoeditor/objectproperties.h>
#include <pandoeditor/geometrypredicates.h>
#include <pandoeditor/timeline-edit.h>
#include <pandoeditor/timeline-resolver.h>
#include <pandoeditor/timeline-view.h>
#include <pandoeditor/temporal.h>
#include <pandoeditor/webcommands.h>
#include "documentstate.h"
#include <algorithm>
#include <cmath>
#include <limits>
#include <set>
#include <stdexcept>
#include <type_traits>
#include <utility>

namespace pandoeditor {
namespace {
template<class Range,class Equal> bool same(const Range& a,const Range& b,Equal equal)
{
    return a.size()==b.size() && std::equal(a.begin(),a.end(),b.begin(),equal);
}
bool sameValidity(const Validity& a,const Validity& b) { return a.from==b.from && a.to==b.to; }
bool sameGeometry(const Geometry& a,const Geometry& b)
{
    auto point=[](Point a,Point b){return a.x==b.x && a.y==b.y;};
    auto ring=[&](const Ring& a,const Ring& b){return same(a,b,point);};
    auto polygon=[&](const Polygon& a,const Polygon& b){return same(a,b,ring);};
    return a.type==b.type && same(a.points,b.points,point) && same(a.lines,b.lines,ring) && same(a.polygons,b.polygons,polygon);
}
} // namespace

ChangeImpact calculateChangeImpact(const ProjectDocument& before,const ProjectDocument& after,
                                   const std::vector<ObjectRef>& targets,const std::string& month) {
    ChangeImpact impact;
    if(!isStaticTimeline(before)||!isStaticTimeline(after)) {
        if(month.empty())throw TimelineError("TIMELINE_CURSOR_REQUIRED","change impact needs a month");
        const auto beforeIndex=validateDocument(before),afterIndex=validateDocument(after);
        std::set<ObjectRef> affected(targets.begin(),targets.end());
        for(const auto& [ref,unused]:beforeIndex.objects)affected.insert(ref);
        for(const auto& [ref,unused]:afterIndex.objects)affected.insert(ref);
        impact.changedObjects.assign(affected.begin(),affected.end());
        impact.sceneDirty.affectedObjects=impact.changedObjects;
        impact.sceneDirty.geometry=true;
        impact.sceneDirty.presentation=true;
        impact.sceneDirty.fullRebuild=true;
        impact.requiresFullSceneRebuild=true;
        for(const auto& target:targets)if(target.domain=="territorial") {
            impact.sceneDirty.geometryObjects.push_back(target);
            for(const auto& row:before.timelineRecords.geometryBindings)
                if(row.objectRef.id==target.id)impact.changedGeometries.push_back(row.geometryRef);
            for(const auto& row:after.timelineRecords.geometryBindings)
                if(row.objectRef.id==target.id)impact.changedGeometries.push_back(row.geometryRef);
        }
        std::sort(impact.changedGeometries.begin(),impact.changedGeometries.end());
        impact.changedGeometries.erase(std::unique(impact.changedGeometries.begin(),impact.changedGeometries.end()),
            impact.changedGeometries.end());
        return impact;
    }
    const auto beforeIndex=validateDocument(before),afterIndex=validateDocument(after);
    std::set<ObjectRef> objects,affected(targets.begin(),targets.end()),geometryObjects;
    std::set<GeometryRef> geometries;
    for(const auto& entry:beforeIndex.objects)objects.insert(entry.first);
    for(const auto& entry:afterIndex.objects)objects.insert(entry.first);
    for(const auto& object:objects) {
        const auto oldRef=objectGeometry(before,beforeIndex,object);
        const auto newRef=objectGeometry(after,afterIndex,object);
        const bool lifetime=beforeIndex.objects.count(object)!=afterIndex.objects.count(object);
        const auto oldShape=oldRef?before.geometries.get(*oldRef):nullptr;
        const auto newShape=newRef?after.geometries.get(*newRef):nullptr;
        // Fallback eligibility changes the effective LOD/projection preparation
        // even when the immutable geographic shape and binding remain identical.
        const bool fallbackPolicy=object.domain=="generic"&&!lifetime&&
            before.genericFeatures.at(beforeIndex.objects.at(object)).fallbackOnly!=
            after.genericFeatures.at(afterIndex.objects.at(object)).fallbackOnly;
        const bool geometry=!(oldRef==newRef)||oldShape!=newShape||fallbackPolicy;
        if(lifetime||geometry)affected.insert(object);
        if(geometry) {
            geometryObjects.insert(object);
            // Both endpoints are necessary when deleting or undoing a replacement.
            if(oldRef)geometries.insert(*oldRef);
            if(newRef)geometries.insert(*newRef);
        }
    }
    const auto sourceKey=[](const SourceProvenance& s) {
        return std::tie(s.kind,s.dataset,s.version,s.sourceId,s.sourceFormat,s.sourceType,s.importedAt,s.details);
    };
    const auto& a=before.presentation;const auto& b=after.presentation;
    const bool globalPresentation=!(a.webPresentation==b.webPresentation)||!same(a.objectStyles,b.objectStyles,[](const auto& x,const auto& y) {
            return x.first==y.first&&std::tie(x.second.color,x.second.explicitColor)==
                 std::tie(y.second.color,y.second.explicitColor);
        });
    const bool relationsChanged=
        !same(before.timelineRecords.lifetimes,after.timelineRecords.lifetimes,[](const auto& x,const auto& y) {
            return x.id==y.id&&x.objectRef==y.objectRef&&sameValidity(x.validity,y.validity);
        })||!same(before.timelineRecords.geometryBindings,after.timelineRecords.geometryBindings,[](const auto& x,const auto& y) {
            return x.id==y.id&&x.objectRef==y.objectRef&&sameValidity(x.validity,y.validity)&&x.geometryRef==y.geometryRef&&x.rendering==y.rendering;
        })||!same(before.timelineRecords.parentRelations,after.timelineRecords.parentRelations,[](const auto& x,const auto& y) {
            return x.id==y.id&&x.objectRef==y.objectRef&&sameValidity(x.validity,y.validity)&&x.parentId==y.parentId&&x.coverageMode==y.coverageMode;
        })||!same(before.timelineRecords.propertyBindings,after.timelineRecords.propertyBindings,[](const auto& x,const auto& y) {
            return x.id==y.id&&x.objectRef==y.objectRef&&sameValidity(x.validity,y.validity)&&x.property==y.property&&x.value==y.value;
        });
    const bool unitPresentation=!same(before.units,after.units,[](const auto& x,const auto& y) {
        return std::tie(x.id,x.name,x.notes,x.kind,x.locked,x.baseName,x.nameExplicit,x.libraryOrigin,
                        x.metadata,x.sourceFolderId,x.sourceEntityId,x.sourceGeometryVersion)==
            std::tie(y.id,y.name,y.notes,y.kind,y.locked,y.baseName,y.nameExplicit,y.libraryOrigin,
                     y.metadata,y.sourceFolderId,y.sourceEntityId,y.sourceGeometryVersion);
    });
    const bool contentPresentation=
        !same(before.countryDetails,after.countryDetails,[](const auto& x,const auto& y) {
            return x.first==y.first&&x.second.capital==y.second.capital;
        })||!same(before.symbols,after.symbols,[](const auto& x,const auto& y) {
            return x.first==y.first&&std::tie(x.second.policy,x.second.embeddedDataUrl,x.second.defaultCountryId,x.second.defaultFlagDataUrl)==
                std::tie(y.second.policy,y.second.embeddedDataUrl,y.second.defaultCountryId,y.second.defaultFlagDataUrl);
        })||!same(before.labels,after.labels,[&](const auto& x,const auto& y) {
            return std::tie(x.id,x.name,x.kind,x.notes,x.territory,x.sourcePlaceId,x.metadata)==std::tie(y.id,y.name,y.kind,y.notes,y.territory,y.sourcePlaceId,y.metadata)&&sourceKey(x.source)==sourceKey(y.source)&&labelWebFields(x)==labelWebFields(y);
        })||!same(before.hydro,after.hydro,[&](const auto& x,const auto& y) {
            return std::tie(x.id,x.name,x.kind,x.notes,x.color,x.locked,x.sourceFeatureId,x.annotations)==
                std::tie(y.id,y.name,y.kind,y.notes,y.color,y.locked,y.sourceFeatureId,y.annotations)&&sourceKey(x.source)==sourceKey(y.source)&&hydroWebPropertyFields(x)==hydroWebPropertyFields(y);
        })||!same(before.genericFeatures,after.genericFeatures,[&](const auto& x,const auto& y) {
            return std::tie(x.id,x.name,x.notes,x.color,x.locked,x.fallbackOnly)==
                std::tie(y.id,y.name,y.notes,y.color,y.locked,y.fallbackOnly)&&sourceKey(x.source)==sourceKey(y.source);
        })||!same(before.distributionLayers,after.distributionLayers,[](const auto& x,const auto& y) {
            return std::tie(x.id,x.name,x.unit,x.color,x.locked,x.parentId,x.groups,x.validity.from,x.validity.to,x.metadata,x.valueScale.manual,x.valueScale.min,x.valueScale.max)==
                std::tie(y.id,y.name,y.unit,y.color,y.locked,y.parentId,y.groups,y.validity.from,y.validity.to,y.metadata,y.valueScale.manual,y.valueScale.min,y.valueScale.max);
        })||!same(before.distributionEntries,after.distributionEntries,[](const auto& x,const auto& y) {
            return std::tie(x.id,x.layerId,x.territory,x.value,x.certainty,x.metadata,x.validity.from,x.validity.to)==
                std::tie(y.id,y.layerId,y.territory,y.value,y.certainty,y.metadata,y.validity.from,y.validity.to);
        });
    const bool extensionsChanged=!same(before.extensions,after.extensions,[](const auto& x,const auto& y) {
        return std::tie(x.id,x.sourceFormat,x.sourceSchema,x.jsonPointer,x.payload,x.status,x.dependencyKnowledge,x.dependencies,x.forbiddenEffects,x.envelopeExtras)==
            std::tie(y.id,y.sourceFormat,y.sourceSchema,y.jsonPointer,y.payload,y.status,y.dependencyKnowledge,y.dependencies,y.forbiddenEffects,y.envelopeExtras);
    });
    auto& dirty=impact.sceneDirty;
    dirty.geometry=!geometryObjects.empty();
    dirty.datasetResource=before.documentId!=after.documentId||
        std::tie(before.physicalData.dataset,before.physicalData.version,before.physicalData.source)!=
        std::tie(after.physicalData.dataset,after.physicalData.version,after.physicalData.source);
    dirty.presentation=globalPresentation||relationsChanged||unitPresentation||contentPresentation||extensionsChanged||
        before.physicalData.hiddenHydroIds!=after.physicalData.hiddenHydroIds;
    // Broad display and reference changes can affect objects outside command targets.
    if(dirty.presentation||dirty.datasetResource)affected.insert(objects.begin(),objects.end());
    dirty.affectedObjects.assign(affected.begin(),affected.end());
    dirty.geometryObjects.assign(geometryObjects.begin(),geometryObjects.end());
    // Lifetime and known reference changes are covered by the complete affected
    // set and effective geometry diff; opaque extension effects remain global.
    dirty.fullRebuild=dirty.datasetResource||extensionsChanged;
    impact.changedObjects=dirty.affectedObjects;
    impact.changedGeometries.assign(geometries.begin(),geometries.end());
    if(dirty.presentation)impact.presentationInvalidations=dirty.affectedObjects;
    impact.requiresFullSpatialRebuild=dirty.datasetResource;
    impact.requiresFullSceneRebuild=dirty.fullRebuild;
    for(const auto& [ref,shape]:after.geometries.versions()) {
        const auto old=before.geometries.versions().find(ref);
        if(old!=before.geometries.versions().end()&&old->second==shape) {
            ++impact.retainedGeometryCount;continue;
        }
        impact.estimatedNewGeometryBytes+=sizeof(Geometry)+shape->points.size()*sizeof(Point);
        for(const auto& line:shape->lines)impact.estimatedNewGeometryBytes+=line.size()*sizeof(Point);
        for(const auto& polygon:shape->polygons)for(const auto& ring:polygon)
            impact.estimatedNewGeometryBytes+=ring.size()*sizeof(Point);
    }
    return impact;
}

const char* commandErrorCode(CommandError error) noexcept
{
    switch(error) {
    case CommandError::None: return "NONE";
    case CommandError::ProjectMismatch: return "PROJECT_MISMATCH";
    case CommandError::DocumentMismatch: return "DOCUMENT_MISMATCH";
    case CommandError::StaleRevision: return "STALE_REVISION";
    case CommandError::InvalidCommand: return "INVALID_COMMAND";
    case CommandError::InvalidTargets: return "INVALID_TARGETS";
    case CommandError::InvalidArguments: return "INVALID_ARGUMENTS";
    case CommandError::Locked: return "LOCKED";
    case CommandError::UnsupportedDependency: return "UNSUPPORTED_DEPENDENCY";
    case CommandError::ValidationFailed: return "VALIDATION_FAILED";
    case CommandError::PrepareFailed: return "PREPARE_FAILED";
    case CommandError::CommitFailed: return "COMMIT_FAILED";
    case CommandError::PreviewConsumed: return "PREVIEW_CONSUMED";
    case CommandError::RevisionOverflow: return "REVISION_OVERFLOW";
    }
    return "UNKNOWN_ERROR";
}
bool sameGeometryValue(const Geometry& a,const Geometry& b) {return sameGeometry(a,b);}
} // namespace pandoeditor
