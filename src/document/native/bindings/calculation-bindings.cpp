#include "session-binding-boundary.h"
#include <pandoeditor/projectcodec.h>
#include <pandoeditor/sphericalpolygon.h>
#include <pandoeditor/geometrypredicates.h>
#include <pandoeditor/temporal.h>
#include <pandoeditor/gisexchange.h>
#include <emscripten/bind.h>
#include <emscripten.h>

using emscripten::val;
using namespace pandoeditor;
using namespace pandoeditor::wasm_session_detail;

namespace {
EM_JS(emscripten::EM_VAL, packReferenceUtf16, (emscripten::EM_VAL handle), {
    const value=Emval.toValue(handle), units=new Uint16Array(value.length);
    for(let i=0;i<value.length;i++)units[i]=value.charCodeAt(i);
    return Emval.toHandle(units);
});
EM_JS(emscripten::EM_VAL, packTerritorialRootNode, (emscripten::EM_VAL handle), {
    const feature=Emval.toValue(handle),properties=feature.properties;
    const rawId=feature.id,id=rawId==null?String():String(rawId),rawParent=properties.parentId,parent=rawParent?String(rawParent):String();
    const kind=properties.entityKind,pack=value=>{const units=new Uint16Array(value.length);
        for(let i=0;i<value.length;i++)units[i]=value.charCodeAt(i);return units;};
    return Emval.toHandle([pack(id),pack(parent),typeof kind==='string'?kind:String()]);
});
EM_JS(emscripten::EM_VAL, unpackReferenceUtf16, (const std::uint16_t* data, unsigned length), {
    let value=String();const start=data>>>1;
    for(let offset=0;offset<length;offset+=8192)
        value+=String.fromCharCode(...HEAPU16.subarray(start+offset,start+Math.min(length,offset+8192)));
    return Emval.toHandle(value);
});
std::u16string referencePackedUtf16(const val& packed) {
    std::vector<std::uint16_t> units(packed["length"].as<unsigned>());
    if (!units.empty())val(emscripten::typed_memory_view(units.size(), units.data())).call<void>("set", packed);
    std::u16string result; result.reserve(units.size());
    for (const auto unit:units)result.push_back(static_cast<char16_t>(unit));
    return result;
}
std::u16string referenceUtf16(const val& input) {
    if (!type(input,"string"))fail("INVALID_REFERENCE_GRAPH","Reference IDs must be strings.");
    return referencePackedUtf16(val::take_ownership(packReferenceUtf16(input.as_handle())));
}
val referenceWebString(const std::u16string& input) {
    static_assert(sizeof(char16_t)==sizeof(std::uint16_t));
    return val::take_ownership(unpackReferenceUtf16(reinterpret_cast<const std::uint16_t*>(input.data()), input.size()));
}
TerritorialRootNode<std::u16string> rootNodeForWeb(const val& feature) {
    const auto packed = val::take_ownership(packTerritorialRootNode(feature.as_handle()));
    const auto kind = packed[2].as<std::string>();
    return {referencePackedUtf16(packed[0]), referencePackedUtf16(packed[1]), kind=="regional", kind=="general"};
}
val territorialRootForWeb(const val& feature, const val& lookup) {
    return boundary([&] {
        if (!type(lookup,"function"))fail("INVALID_REFERENCE_GRAPH","A territorial lookup is required.");
        const auto result = inspectTerritorialRoot(rootNodeForWeb(feature), [&](const std::u16string& id)->std::optional<TerritorialRootNode<std::u16string>>{
            const auto parent = lookup(referenceWebString(id));
            if (!val::global("Boolean")(parent).as<bool>())return std::nullopt;
            return rootNodeForWeb(parent);
        });
        const char* status = nullptr;
        switch (result.status) {
        case TerritorialRootStatus::Valid:status = "valid"; break;
        case TerritorialRootStatus::RegionalParent:status = "regional-parent"; break;
        case TerritorialRootStatus::Cycle:status = "cycle"; break;
        case TerritorialRootStatus::MissingParent:
        case TerritorialRootStatus::WrongParentKind:status = "invalid-parent"; break;
        }
        auto value = val::object(); value.set("status", std::string(status)); value.set("rootId", referenceWebString(result.root)); return value;
    });
}
val referenceGraphForWeb(const val& ids, const val& parents) {
    return boundary([&] {
        array(ids,"INVALID_REFERENCE_GRAPH"); array(parents,"INVALID_REFERENCE_GRAPH");
        const auto length = ids["length"].as<unsigned>();
        if (parents["length"].as<unsigned>()!=length)fail("INVALID_REFERENCE_GRAPH","Reference arrays must have equal length.");
        std::vector<std::u16string> values; values.reserve(length);
        std::map<std::u16string, std::optional<std::u16string>> graph;
        for (unsigned i = 0; i<length; ++i) {auto id = referenceUtf16(ids[i]), parent = referenceUtf16(parents[i]);
            values.push_back(id); graph[id] = parent.empty()?std::nullopt:std::optional<std::u16string>(std::move(parent));}
        std::set<std::u16string> seen; auto output = val::array();
        for (unsigned i = 0; i<length; ++i) {const auto& id = values[i]; auto row = val::object();
            const auto status = id.empty()?"empty":seen.insert(id).second?"ok":"duplicate";
            const auto chain = inspectReferenceChain(graph, id);
            row.set("idStatus", std::string(status)); row.set("cycle", chain==ReferenceChainStatus::Cycle);
            row.set("missing", chain==ReferenceChainStatus::Missing); output.set(i, row);
        }
        return output;
    });
}
val gisCountryMergeForWeb(const val& current, const val& incoming) {
    return boundary([&] {
        array(current,"INVALID_GIS_COUNTRY_IDS"); array(incoming,"INVALID_GIS_COUNTRY_IDS");
        std::vector<std::u16string> currentIds, incomingIds;
        for (unsigned i = 0; i<current["length"].as<unsigned>(); ++i)currentIds.push_back(referenceUtf16(current[i]));
        for (unsigned i = 0; i<incoming["length"].as<unsigned>(); ++i)incomingIds.push_back(referenceUtf16(incoming[i]));
        const auto plan = planGisCountryMerge(currentIds, incomingIds);
        auto output = val::object(), existing = val::array(), unaffected = val::array();
        const char* status = plan.status==GisCountryMergeStatus::Valid?"valid":
            plan.status==GisCountryMergeStatus::Empty?"empty":"invalid-ids";
        output.set("status", std::string(status)); output.set("matched", unsigned(plan.matched));
        for (unsigned i = 0; i<plan.existing.size(); ++i)existing.set(i, plan.existing[i]);
        for (unsigned i = 0; i<plan.unaffected.size(); ++i)unaffected.set(i, unsigned(plan.unaffected[i]));
        output.set("existing", existing); output.set("unaffected", unaffected); return output;
    });
}
val gisCountryGeometryForWeb(unsigned incomingCount, const val& unaffected, bool replaceById, const val& callbacks) {
    return boundary([&] {
        array(unaffected,"INVALID_GIS_COUNTRY_IDS");
        std::vector<std::size_t> indices;
        for (unsigned i = 0; i<unaffected["length"].as<unsigned>(); ++i)indices.push_back(unaffected[i].as<unsigned>());
        GisCountryMergeOperations operations;
        operations.prepare = [&]{callbacks.call<void>("prepare");};
        operations.bounds = [&](int incoming, std::size_t country) {return callbacks.call<bool>("bounds", incoming, unsigned(country));};
        operations.intersection = [&](int incoming, std::size_t country)->std::optional<double>{
            const auto value = callbacks.call<val>("intersection", incoming, unsigned(country));
            return value.isNull()||value.isUndefined()?std::nullopt:std::optional<double>(value.as<double>());
        };
        operations.area = [&]{return callbacks.call<double>("area");};
        operations.subtract = [&](std::size_t country) {return callbacks.call<bool>("subtract", unsigned(country));};
        const auto plan = planGisCountryGeometry(incomingCount, indices, replaceById, operations);
        auto output = val::object(), donors = val::array(); output.set("overlapAreaKm2", plan.overlapAreaKm2);
        for (unsigned i = 0; i<plan.donors.size(); ++i) {auto donor = val::object(); donor.set("index", unsigned(plan.donors[i].index));
            donor.set("removed", plan.donors[i].removed); donors.set(i, donor);}
        output.set("donors", donors); return output;
    });
}
val distributionReferencesForWeb(const val& layerIds, const val& territoryIds, const val& layers,
    const val& modes, const val& territories, const val& values) {
    return boundary([&] {
        for (const auto& v:{layerIds, territoryIds, layers, modes, territories, values})array(v,"INVALID_REFERENCE_GRAPH");
        const auto length = layers["length"].as<unsigned>();
        if (modes["length"].as<unsigned>()!=length||territories["length"].as<unsigned>()!=length||
            values["length"].as<unsigned>()!=length)fail("INVALID_REFERENCE_GRAPH","Reference arrays must have equal length.");
        std::set<std::u16string> knownLayers, knownTerritories;
        for (unsigned i = 0; i<layerIds["length"].as<unsigned>(); ++i)knownLayers.insert(referenceUtf16(layerIds[i]));
        for (unsigned i = 0; i<territoryIds["length"].as<unsigned>(); ++i)knownTerritories.insert(referenceUtf16(territoryIds[i]));
        auto output = val::array();
        for (unsigned i = 0; i<length; ++i) {
            const auto layer = referenceUtf16(layers[i]), modeName = referenceUtf16(modes[i]), territory = referenceUtf16(territories[i]);
            const auto mode = modeName==u"territorial"?DistributionReferenceMode::Territorial:
                modeName==u"geometry"?DistributionReferenceMode::Geometry:DistributionReferenceMode::Invalid;
            const bool finite = type(values[i],"number")&&std::isfinite(values[i].as<double>());
            const auto status = inspectDistributionReference(knownLayers.count(layer), mode, finite, knownTerritories.count(territory));
            auto row = val::object(); row.set("missingLayer", status.missingLayer); row.set("invalidMode", status.invalidMode);
            row.set("invalidValue", status.invalidValue); row.set("missingTerritory", status.missingTerritory); output.set(i, row);
        }
        return output;
    });
}
EM_JS(emscripten::EM_VAL, packTerritorialRing, (emscripten::EM_VAL handle), {
    const ring=Emval.toValue(handle), points=new Float64Array(ring.length*2);
    for(let i=0;i<ring.length;++i){if(ring.length<4&&!Array.isArray(ring[i]))continue;points[i*2]=Number(ring[i][0]);points[i*2+1]=Number(ring[i][1]);}
    return Emval.toHandle(points);
});
val territorialRingValidation(const val& input, bool clipped) {
    return boundary([&] {
        array(input,"INVALID_GEOMETRY");
        const auto count = input["length"].as<unsigned>();
        const auto packed = val::take_ownership(packTerritorialRing(input.as_handle()));
        std::vector<double> points(count*2);
        if (!points.empty())val(emscripten::typed_memory_view(points.size(), points.data())).call<void>("set", packed);
        Ring ring; ring.reserve(count);
        for (unsigned i = 0; i<count; ++i)ring.push_back({points[i*2], points[i*2+1]});
        auto output = val::array(); unsigned index = 0;
        for (const auto& issue:clipped?validateClippedTerritorialRing(ring):validateTerritorialRing(ring)) {
            auto row = val::object(); row.set("kind", issue.kind);
            if (issue.coordinateIndex)row.set("coordinate", input[static_cast<unsigned>(*issue.coordinateIndex)]);
            else if (issue.kind=="self-intersection") {auto coordinate = val::array(); coordinate.set(0, issue.coordinate.x); coordinate.set(1, issue.coordinate.y); row.set("coordinate", coordinate);}
            if (issue.vertexIndex)row.set("vertexIndex", static_cast<unsigned>(*issue.vertexIndex));
            if (issue.segmentIndex)row.set("segmentIndex", static_cast<unsigned>(*issue.segmentIndex));
            output.set(index++, row);
        }
        return output;
    });
}
val territorialRingValidationForWeb(const val& input) {return territorialRingValidation(input, false);}
val clippedTerritorialRingValidationForWeb(const val& input) {return territorialRingValidation(input, true);}
val polygonGeometry(const val& input, bool clipped) {
    return boundary([&] {
        const auto encoded = val::global("JSON").call<val>("stringify", input).as<std::string>();
        const auto source = projectcodec::readWebGeometry(codecjson::parse(encoded));
        const auto result = clipped?normalizeClippedSphericalPolygonGeometry(source)
                                 :normalizeSphericalPolygonGeometry(source);
        return val::global("JSON").call<val>("parse", projectcodec::webGeometryValue(result).encode());
    });
}
val polygonRing(const val& input, bool shell) {
    return boundary([&] {
        auto source = val::object(); source.set("type", std::string("Polygon"));
        auto coordinates = val::array(); coordinates.set(0, input); source.set("coordinates", coordinates);
        const auto encoded = val::global("JSON").call<val>("stringify", source).as<std::string>();
        const auto parsed = projectcodec::readWebGeometry(codecjson::parse(encoded));
        Geometry output; output.type = "Polygon";
        output.polygons.push_back({normalizeSphericalRing(parsed.polygons.at(0).at(0), shell)});
        return val::global("JSON").call<val>("parse", projectcodec::webGeometryValue(output).encode())["coordinates"][0];
    });
}
// The Web boundary carries immutable dates; the shared Core owns calendar arithmetic.
val temporalKeyForWeb(const TemporalKey& key) {
    auto output = val::array();
    output.set(0, key.year); output.set(1, key.month); output.set(2, key.day);
    return output;
}
val temporalValueForWeb(const TemporalValue& input) {
    auto output = val::object();
    output.set("source", webString(input.text));
    output.set("canonical", webString(input.canonical));
    output.set("precision", webString(input.precision));
    output.set("year", input.year);
    output.set("month", input.month?val(*input.month):val::null());
    output.set("day", input.day?val(*input.day):val::null());
    output.set("startKey", temporalKeyForWeb(input.startKey));
    output.set("endKey", temporalKeyForWeb(input.endKey));
    return output;
}
std::optional<std::string> temporalEndpointForWeb(const val& value) {
    return value.isNull()||value.isUndefined()?std::nullopt:std::optional<std::string>(text(value,"PL-TEMPORAL-001", true));
}
val temporalParseForWeb(const std::string& input) {
    return boundary([&]{return temporalValueForWeb(parseTemporal(input));});
}
val temporalMonthEndForWeb(const std::string& input) {
    return boundary([&]{return temporalValueForWeb(temporalMonthEnd(input));});
}
int temporalCompareForWeb(const std::string& left, const std::string& right, bool leftEnd, bool rightEnd) {
    return boundary([&]{return compareTemporal(parseTemporal(left), parseTemporal(right),
        leftEnd?TemporalBoundary::End:TemporalBoundary::Start,
        rightEnd?TemporalBoundary::End:TemporalBoundary::Start);});
}
val temporalNormalizeIntervalForWeb(val from, val to) {
    return boundary([&] {
        TemporalInterval interval;
        try {interval = normalizeTemporalInterval(temporalEndpointForWeb(from), temporalEndpointForWeb(to));}
        catch (const std::invalid_argument& error) {
            if (std::string(error.what())=="INVALID_DATE: reversed interval")
                fail("PL-TEMPORAL-INTERVAL","유효기간 시작은 종료보다 늦을 수 없습니다.");
            throw;
        }
        auto result = val::object();
        result.set("validFrom", optional(interval.validFrom));
        result.set("validTo", optional(interval.validTo));
        return result;
    });
}
bool temporalContainsForWeb(val from, val to, const std::string& point) {
    return boundary([&]{return temporalContains(
        normalizeTemporalInterval(temporalEndpointForWeb(from), temporalEndpointForWeb(to)), parseTemporal(point));});
}
bool temporalIntervalsOverlapForWeb(val fromA, val toA, val fromB, val toB) {
    return boundary([&] {return temporalIntervalsOverlap(
        normalizeTemporalInterval(temporalEndpointForWeb(fromA), temporalEndpointForWeb(toA)),
        normalizeTemporalInterval(temporalEndpointForWeb(fromB), temporalEndpointForWeb(toB)));});
}
std::string temporalShiftMonthForWeb(const std::string& month, int delta) {
    return boundary([&]{return shiftTemporalMonth(month, delta);});
}
TemporalKey temporalKeyFromWeb(const val& input) {
    array(input,"PL-TEMPORAL-001");
    if (input["length"].as<unsigned>()!=3)fail("PL-TEMPORAL-001","A year/month/day tuple is required.");
    return {integer(input[0],"PL-TEMPORAL-001"), integer(input[1],"PL-TEMPORAL-001"),
        integer(input[2],"PL-TEMPORAL-001")};
}
int temporalCompareKeysForWeb(val a, val b) {
    return boundary([&] {
        const auto left = temporalKeyFromWeb(a), right = temporalKeyFromWeb(b);
        return left==right?0:left<right?-1:1;
    });
}
val temporalFollowingDayForWeb(val date) {
    return boundary([&]{return temporalKeyForWeb(temporalFollowingDay(temporalKeyFromWeb(date)));});
}
// The shared Core owns the spherical integral; the binding validates its input.
Ring checkedSphericalRing(const val& input) {
    array(input,"INVALID_POLYGON_RING");
    const auto length = input["length"].as<unsigned>();
    if (length<4||length>2'000'000)
        fail("INVALID_POLYGON_RING","Expected 4..2,000,000 coordinates.");
    Ring ring; ring.reserve(length);
    for (unsigned index = 0; index<length; ++index) {
        const val coordinate = input[index];
        array(coordinate,"INVALID_POLYGON_COORDINATE");
        if (coordinate["length"].as<unsigned>()!=2||!type(coordinate[0],"number")
           ||!type(coordinate[1],"number"))
            fail("INVALID_POLYGON_COORDINATE","Expected a numeric longitude/latitude pair.");
        const double longitude = coordinate[0].as<double>();
        const double latitude = coordinate[1].as<double>();
        if (!std::isfinite(longitude)||!std::isfinite(latitude)||std::abs(latitude)>90)
            fail("INVALID_POLYGON_COORDINATE","Expected finite geographic coordinates.");
        ring.push_back({longitude, latitude});
    }
    if (ring.front().x!=ring.back().x||ring.front().y!=ring.back().y)
        fail("INVALID_POLYGON_RING","Ring must be closed.");
    return ring;
}
double sphericalRingAreaForWeb(const val& input) {
    return boundary([&]{return sphericalRingSignedArea(checkedSphericalRing(input));});
}
val sphericalRingAreasForWeb(const val& inputs) {
    return boundary([&] {
        array(inputs,"INVALID_POLYGON_RING");
        const auto count = inputs["length"].as<unsigned>();
        if (count>16'384)fail("INVALID_POLYGON_RING","Batch exceeds 16,384 rings.");
        auto values = val::array();
        for (unsigned index = 0; index<count; ++index)
            values.set(index, sphericalRingSignedArea(checkedSphericalRing(inputs[index])));
        return values;
    });
}
bool canonicalPolygonGeometry(const val& input) {
    try {
        const auto encoded = val::global("JSON").call<val>("stringify", input).as<std::string>();
        return hasCanonicalSphericalWinding(projectcodec::readWebGeometry(codecjson::parse(encoded)));
    }catch (...) {return false;}
}
bool canonicalClippedPolygonGeometry(const val& input) {
    try {
        const auto encoded = val::global("JSON").call<val>("stringify", input).as<std::string>();
        return hasCanonicalSphericalWinding(projectcodec::readWebGeometry(codecjson::parse(encoded)), true);
    }catch (...) {return false;}
}
}

void pandoeditor::wasm_session_detail::registerDocumentCalculationBindings() {
    emscripten::function("sphericalRingSignedArea", &sphericalRingAreaForWeb);
    emscripten::function("validateTerritorialRing", &territorialRingValidationForWeb);
    emscripten::function("validateClippedTerritorialRing", &clippedTerritorialRingValidationForWeb);
    emscripten::function("referenceGraphDiagnostics", &referenceGraphForWeb);
    emscripten::function("planGisCountryMerge", &gisCountryMergeForWeb);
    emscripten::function("planGisCountryGeometry", &gisCountryGeometryForWeb);
    emscripten::function("gisCountryMergeCanCommit", &gisCountryMergeCanCommit);
    emscripten::function("resolveTerritorialRoot", &territorialRootForWeb);
    emscripten::function("distributionReferenceDiagnostics", &distributionReferencesForWeb);
    emscripten::function("sphericalRingSignedAreas", &sphericalRingAreasForWeb);
    emscripten::function("temporalParse", &temporalParseForWeb);
    emscripten::function("temporalMonthEnd", &temporalMonthEndForWeb);
    emscripten::function("temporalCompare", &temporalCompareForWeb);
    emscripten::function("temporalNormalizeInterval", &temporalNormalizeIntervalForWeb);
    emscripten::function("temporalContains", &temporalContainsForWeb);
    emscripten::function("temporalIntervalsOverlap", &temporalIntervalsOverlapForWeb);
    emscripten::function("temporalShiftMonth", &temporalShiftMonthForWeb);
    emscripten::function("temporalCompareKeys", &temporalCompareKeysForWeb);
    emscripten::function("temporalFollowingDay", &temporalFollowingDayForWeb);
    emscripten::function("normalizePolygonGeometry", &polygonGeometry);
    emscripten::function("normalizePolygonRing", &polygonRing);
    emscripten::function("hasCanonicalPolygonWinding", &canonicalPolygonGeometry);
    emscripten::function("hasCanonicalClippedPolygonWinding", &canonicalClippedPolygonGeometry);
}
