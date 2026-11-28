#include <pandoeditor/timeline-view.h>
#include <pandoeditor/timeline-edit.h>
#include <pandoeditor/losslessjson.h>
#include <pandoeditor/geometrypredicates.h>
#include <algorithm>
#include <set>
#include <stdexcept>

namespace pandoeditor {
namespace {
using V = codecjson::Value;
std::string nameValue(const TerritorialUnit& unit) {
    auto value = V::obj(); value.object["name"] = V::str(unit.name); value.object["nameExplicit"] = V::boolean(unit.nameExplicit);
    const auto metadata = codecjson::parse(unit.metadata);
    if (metadata.object.count("nameDetails"))value.object["names"] = normalizeTerritorialNames(metadata.object.at("nameDetails"));
    return value.encode();
}
void nameDetails(TerritorialUnit& unit, const V& value, const char* key) {
    auto metadata = codecjson::parse(unit.metadata); metadata.object.erase("nameDetails");
    if (value.object.count(key))metadata.object["nameDetails"] = normalizeTerritorialNames(value.object.at(key));
    unit.metadata = metadata.encode();
}
std::string colorValue(const ObjectStyle& style) {
    auto value = V::obj(); value.object["color"] = V::num(style.color); value.object["explicitColor"] = V::boolean(style.explicitColor); return value.encode();
}
std::string flagValue(const ProjectDocument& document, const ObjectRef& ref) {
    const auto found = document.symbols.find(ref); const auto symbol = found==document.symbols.end()?TerritorialSymbolStyle{}:found->second;
    auto value = V::obj(); value.object["policy"] = V::str(symbol.policy==FlagPolicy::Embedded?"embedded":symbol.policy==FlagPolicy::None?"none":"default");
    value.object["embeddedDataUrl"] = V::str(symbol.embeddedDataUrl); value.object["defaultCountryId"] = V::str(symbol.defaultCountryId);
    value.object["defaultFlagDataUrl"] = symbol.defaultFlagDataUrl?V::str(*symbol.defaultFlagDataUrl):V{}; return value.encode();
}
bool overlap(std::initializer_list<Validity> intervals) {
    std::optional<TemporalKey> start, end;
    for (const auto& validity:intervals) {
        const auto interval = normalizeTemporalInterval(validity.from, validity.to);
        if (interval.start&&(!start||*start<interval.start->startKey))start = interval.start->startKey;
        if (interval.end&&(!end||interval.end->endKey<*end))end = interval.end->endKey;
    }
    return !start||!end||!(*end<*start);
}
void applyProperties(ProjectDocument& document, const ResolvedWorld& world) {
    if (world.activeProperties().empty())return;
    std::map<std::string, TerritorialUnit*> units; for (auto& unit:document.units)units.emplace(unit.id, &unit);
    std::map<std::string, HydroFeature*> waters; for (auto& water:document.hydro)waters.emplace(water.id, &water);
    for (const auto& [ref, properties]:world.activeProperties())
        for (const auto& [property, encoded]:*properties) {
        if (ref.domain=="hydro") {
            const auto found = waters.find(ref.id);
            if (found==waters.end())throw TimelineError("TIMELINE_ENTITY","Water identity missing.");
            const auto value = codecjson::parse(encoded);
            if (property=="name")found->second->name = value.object.at("name").string;
            else if (property=="color")found->second->color = static_cast<std::uint32_t>(std::stod(value.object.at("color").raw));
            continue;
        }
        auto& unit = *units.at(ref.id); const auto ref = territorialRef(unit.id); const auto value = codecjson::parse(encoded);
        if (property=="name") {unit.name = value.object.at("name").string; unit.nameExplicit = value.object.at("nameExplicit").raw=="true"; nameDetails(unit, value,"names");}
        else if (property=="color") {auto& style = document.presentation.objectStyles.at(ref); style.color = static_cast<std::uint32_t>(std::stod(value.object.at("color").raw)); style.explicitColor = value.object.at("explicitColor").raw=="true";}
        else {
            TerritorialSymbolStyle symbol; const auto policy = value.object.at("policy").string;
            symbol.policy = policy=="embedded"?FlagPolicy::Embedded:policy=="none"?FlagPolicy::None:FlagPolicy::Default;
            symbol.embeddedDataUrl = value.object.at("embeddedDataUrl").string; symbol.defaultCountryId = value.object.at("defaultCountryId").string;
            const auto& original = value.object.at("defaultFlagDataUrl"); if (original.kind!=V::Null)symbol.defaultFlagDataUrl = original.string;
            document.symbols[ref] = std::move(symbol);
        }
    }
}
}
TimelineDocumentProjection projectResolvedTimeline(const ProjectDocument& source, const ResolvedWorld& world, bool requireGeometry) {
    TimelineDocumentProjection result;
    if (requireGeometry)source.geometries.requireReady(world.requiredGeometries());
    // Copy only the live document domains. The historical archive is not
    // part of this static view and must not be copied just to discard it.
    auto& document = result.document;
    document.documentId = source.documentId; document.exchangeMetadata = source.exchangeMetadata;
    document.units = source.units; document.dirtyTerritorialIds = source.dirtyTerritorialIds;
    document.countryDetails = source.countryDetails; document.symbols = source.symbols; document.labels = source.labels;
    document.hydro = source.hydro; document.distributionLayers = source.distributionLayers;
    document.distributionEntries = source.distributionEntries; document.genericFeatures = source.genericFeatures;
    document.physicalData = source.physicalData; document.geometries = source.geometries;
    document.geometryProvenance = source.geometryProvenance; document.presentation = source.presentation;
    document.extensions = source.extensions;
    auto& records = document.timelineRecords;
    records.lifetimes.reserve(source.units.size()+source.hydro.size());
    records.geometryBindings.reserve(source.units.size()+source.hydro.size());
    records.parentRelations.reserve(source.units.size());
    std::set<ObjectRef> appended;
    const auto append = [&](const ObjectRef& ref, GeometryRef geometry, const std::string& rendering = "{}") {
        if (!appended.insert(ref).second)throw TimelineError("TIMELINE_ENTITY","Duplicate static projection identity.");
        const auto key = ref.domain+":"+ref.id;
        records.lifetimes.push_back({"lifetime:"+key, ref, {}});
        records.geometryBindings.push_back({"geometry:"+key, ref, {}, std::move(geometry), rendering});
    };
    std::map<ObjectRef, const TimelineGeometryBinding*> firstBindings;
    bool fallbackIndexed = false;
    const auto fallbackBinding = [&](const ObjectRef& ref)->const TimelineGeometryBinding& {
        if (!fallbackIndexed) {
            for (const auto& binding:source.timelineRecords.geometryBindings)
                firstBindings.emplace(binding.objectRef, &binding);
            fallbackIndexed = true;
        }
        const auto found = firstBindings.find(ref);
        if (found==firstBindings.end())throw TimelineError("TIMELINE_GEOMETRY","Missing entity binding.");
        return *found->second;
    };
    for (const auto& unit:source.units) {
        const auto* active = world.find(territorialRef(unit.id));
        GeometryRef geometry;
        std::string parent, coverage = "explicit";
        if (active) {
            geometry = active->geometryRef;
            parent = active->parentId;
            coverage = active->coverageMode;
        } else {
            result.inactiveIds.insert(territorialRef(unit.id));
            geometry = fallbackBinding(territorialRef(unit.id)).geometryRef;
        }
        const auto ref = territorialRef(unit.id);
        append(ref, geometry);
        records.parentRelations.push_back({"parent:"+unit.id, ref, {}, parent, coverage});
        if (!active)document.presentation.webPresentation.itemVisibility["objects"][unit.id] = false;
    }
    for (const auto& water:source.hydro) {
        const ObjectRef ref{"hydro", water.id}; const auto* active = world.find(ref);
        if (!active) {
            const auto& binding = fallbackBinding(ref);
            append(ref, binding.geometryRef, binding.rendering);
        } else {
            append(ref, active->geometryRef, active->rendering);
        }
        if (!active) {result.inactiveIds.insert(ref); result.document.presentation.webPresentation.itemVisibility["hydro"][water.id] = false;}
    }
    applyProperties(result.document, world);
    return result;
}
TimelineDocumentView timelineDocumentView(const ProjectDocument& source, const std::string& month, const ResolvedWorld* resolved, bool requireGeometry) {
    if (resolved&&resolved->month!=parseTemporal(month).canonical)
        throw TimelineError("STALE_REVISION","Resolved timeline month differs from requested projection");
    auto world = resolved?*resolved:resolveWorld(source.timelineRecords,
        {timelineEntityCatalog(source), [&](const ObjectRef&, const GeometryRef& ref) {return source.geometries.type(ref);}}, month);
    auto projection = projectResolvedTimeline(source, world, requireGeometry);
    return {std::move(projection.document), std::move(world), std::move(projection.inactiveIds)};
}
void captureTimelinePropertyChanges(const ProjectDocument& source, const ProjectDocument& beforeView,
    ProjectDocument& candidate, const std::string& month) {
    std::map<std::string, const TerritorialUnit*> originals, projected;
    for (const auto& unit:source.units)originals.emplace(unit.id, &unit);
    for (const auto& unit:beforeView.units)projected.emplace(unit.id, &unit);
    const auto point = temporalMonthEnd(month);
    for (auto& unit:candidate.units) {
        if (std::none_of(candidate.timelineRecords.lifetimes.begin(), candidate.timelineRecords.lifetimes.end(), [&](const auto& row) {return row.objectRef==territorialRef(unit.id)&&validityContainsAtEnd(row.validity, point);}))continue;
        const auto found = originals.find(unit.id), prior = projected.find(unit.id);
        if (found==originals.end()||prior==projected.end())continue;
        const auto ref = territorialRef(unit.id);
        const auto write = [&](const char* property, const std::string& oldValue, const std::string& nextValue) {
            if (oldValue!=nextValue)candidate.timelineRecords = replacePropertyBindingAtMonth(candidate.timelineRecords, territorialRef(unit.id), month, property, nextValue);
        };
        write("name", nameValue(*prior->second), nameValue(unit));
        write("color", colorValue(beforeView.presentation.objectStyles.at(ref)), colorValue(candidate.presentation.objectStyles.at(ref)));
        write("flag", flagValue(beforeView, ref), flagValue(candidate, ref));
        unit.name = found->second->name; unit.nameExplicit = found->second->nameExplicit;
        nameDetails(unit, codecjson::parse(found->second->metadata),"nameDetails");
        auto& style = candidate.presentation.objectStyles.at(ref); const auto& baseline = source.presentation.objectStyles.at(ref);
        style.color = baseline.color; style.explicitColor = baseline.explicitColor;
        const auto symbol = source.symbols.find(ref);
        if (symbol==source.symbols.end())candidate.symbols.erase(ref); else candidate.symbols[ref] = symbol->second;
    }
    for (auto& water:candidate.hydro) {
        const ObjectRef ref{"hydro", water.id};
        const auto old = std::find_if(source.hydro.begin(), source.hydro.end(), [&](const auto& row) {return row.id==water.id;});
        const auto prior = std::find_if(beforeView.hydro.begin(), beforeView.hydro.end(), [&](const auto& row) {return row.id==water.id;});
        if (old==source.hydro.end()||prior==beforeView.hydro.end())continue;
        if (std::none_of(candidate.timelineRecords.lifetimes.begin(), candidate.timelineRecords.lifetimes.end(), [&](const auto& row) {return row.objectRef==ref&&validityContainsAtEnd(row.validity, point);}))continue;
        if (water.name!=prior->name) {
            auto value = V::obj(); value.object["name"] = V::str(water.name); value.object["nameExplicit"] = V::boolean(true);
            candidate.timelineRecords = replacePropertyBindingAtMonth(candidate.timelineRecords, ref, month,"name", value.encode());
        }
        if (water.color!=prior->color) {
            auto value = V::obj(); value.object["color"] = V::num(water.color); value.object["explicitColor"] = V::boolean(true);
            candidate.timelineRecords = replacePropertyBindingAtMonth(candidate.timelineRecords, ref, month,"color", value.encode());
        }
        water.name = old->name; water.color = old->color;
    }

}
void validateTimelineParentChanges(const ProjectDocument& before, const ProjectDocument& after) {
    // Build affected intervals once; validation never scans original segments.
    std::map<ObjectRef, std::vector<Validity>> geometryChanges, relationChanges;
    std::map<std::string, const TimelineGeometryBinding*> oldGeometry;
    std::map<std::string, const TimelineParentRelation*> oldRelations;
    for (const auto& row:before.timelineRecords.geometryBindings)oldGeometry.emplace(row.id, &row);
    for (const auto& row:before.timelineRecords.parentRelations)oldRelations.emplace(row.id, &row);
    const auto covers = [](const Validity& outer, const Validity& inner) {
        const auto a = normalizeTemporalInterval(outer.from, outer.to), b = normalizeTemporalInterval(inner.from, inner.to);
        return (!a.start||(b.start&&!(b.start->startKey<a.start->startKey)))&&(!a.end||(b.end&&!(a.end->endKey<b.end->endKey)));
    };
    for (const auto& row:after.timelineRecords.geometryBindings) {
        const auto old = oldGeometry.find(row.id);
        if (old==oldGeometry.end()||!(old->second->geometryRef==row.geometryRef)||!covers(old->second->validity, row.validity))geometryChanges[row.objectRef].push_back(row.validity);
    }
    for (const auto& row:after.timelineRecords.parentRelations) {
        const auto old = oldRelations.find(row.id);
        if (old==oldRelations.end()||old->second->parentId!=row.parentId||old->second->coverageMode!=row.coverageMode||!covers(old->second->validity, row.validity))relationChanges[row.objectRef].push_back(row.validity);
    }
    std::map<ObjectRef, std::vector<const TimelineGeometryBinding*>> shapes;
    std::map<std::pair<GeometryRef, GeometryRef>, bool> containment;
    for (const auto& row:after.timelineRecords.geometryBindings)shapes[row.objectRef].push_back(&row);
    for (const auto& relation:after.timelineRecords.parentRelations)if (!relation.parentId.empty()) {
        std::vector<Validity> changed = relationChanges[relation.objectRef];
        for (const auto& owner:{relation.objectRef, territorialRef(relation.parentId)}) {
            const auto found = geometryChanges.find(owner); if (found!=geometryChanges.end())changed.insert(changed.end(), found->second.begin(), found->second.end());
        }
        if (changed.empty())continue;
        for (const auto* child:shapes[relation.objectRef])for (const auto* parent:shapes[territorialRef(relation.parentId)]) {
            if (!std::any_of(changed.begin(), changed.end(), [&](const auto& interval) {return overlap({relation.validity, child->validity, parent->validity, interval});}))continue;
            const auto key = std::make_pair(parent->geometryRef, child->geometryRef);
            auto result = containment.find(key);
            if (result==containment.end()) {
                const auto outer = after.geometries.get(parent->geometryRef), inner = after.geometries.get(child->geometryRef);
                if (!outer||!inner)throw TimelineError("TIMELINE_GEOMETRY","Missing parent/child geometry.");
                result = containment.emplace(key, geometryContains(*outer, *inner)).first;
            }
            if (!result->second)
                throw TimelineError("GEOMETRY_OUTSIDE_PARENT","Child "+relation.objectRef.id+" is outside parent "+relation.parentId+" during the edited interval.");
        }
    }
}
}
