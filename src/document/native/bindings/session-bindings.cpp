#include <pandoeditor/document-session.h>
#include "session-binding-boundary.h"
#include <pandoeditor/projectcodec.h>
#include <pandoeditor/sphericalpolygon.h>
#include <pandoeditor/geometrypredicates.h>
#include <pandoeditor/temporal.h>
#include <pandoeditor/gisexchange.h>
#include <pandoeditor/timeline-edit.h>
#include <pandoeditor/webcommands.h>
#include <pandoeditor/webterritorial-source-codec.h>
#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <emscripten.h>
#include <emscripten/version.h>
#include <cmath>
#include <initializer_list>
#include <algorithm>

using emscripten::val;
using namespace pandoeditor;
using namespace pandoeditor::wasm_session_detail;
namespace {
val geometry(const GeometryRef& ref) { auto value = val::object(); value.set("id", webString(ref.id)); value.set("version", ref.version); return value; }
val object(const ObjectRef& ref) { auto value = val::object(); value.set("domain", webString(ref.domain)); value.set("id", webString(ref.id)); return value; }
val worldEntity(const ResolvedEntity& row) {
    auto v = val::object(); v.set("objectRef", object(row.objectRef)); v.set("geometryRef", geometry(row.geometryRef)); v.set("rendering", val::global("JSON").call<val>("parse", row.rendering));
    v.set("parentId", webString(row.parentId)); v.set("coverageMode", webString(row.coverageMode)); v.set("rootId", webString(row.rootId));
    v.set("validFrom", optional(row.validity.from)); v.set("validTo", optional(row.validity.to));
    auto ancestors = val::array(); unsigned j = 0; for (const auto& id:row.ancestors)ancestors.set(j++, webString(id));
    auto properties = val::object(); for (const auto& [name, json]:row.properties())properties.set(name, val::global("JSON").call<val>("parse", json));
    v.set("properties", properties); v.set("ancestors", ancestors); return v;
}
val world(const ResolvedWorld& result) {
    auto value = val::object(), entities = val::array(); value.set("month", result.month);
    unsigned i = 0; for (const auto& row:result.entities())entities.set(i++, worldEntity(row));
    value.set("entities", entities); return value;
}
bool sameWorldStructure(const ResolvedEntity& a, const ResolvedEntity& b) {
    return &a==&b||(a.objectRef==b.objectRef&&a.geometryRef==b.geometryRef&&a.rendering==b.rendering
        &&a.parentId==b.parentId&&a.coverageMode==b.coverageMode&&a.rootId==b.rootId
        &&a.ancestors==b.ancestors&&a.validity.from==b.validity.from&&a.validity.to==b.validity.to);
}
bool sameWorldEntity(const ResolvedEntity& a, const ResolvedEntity& b) {
    return sameWorldStructure(a, b)&&(a.propertyValues==b.propertyValues||a.properties()==b.properties());
}
val worldUpdate(const ResolvedEntity& row, const ResolvedEntity* before, std::size_t index, bool allowPatch) {
    auto update = val::object(); update.set("index", double(index));
    if (allowPatch&&before&&sameWorldStructure(*before, row)) {
        auto patch = val::object(), set = val::object(), removed = val::array();
        const auto& prior = before->properties(); const auto& next = row.properties();
        const auto json = val::global("JSON");
        for (const auto& [name, value]:next) {
            const auto found = prior.find(name);
            if (found==prior.end()||found->second!=value)set.set(name, json.call<val>("parse", value));
        }
        unsigned i = 0; for (const auto& [name, value]:prior)if (!next.count(name))removed.set(i++, webString(name));
        patch.set("objectRef", object(row.objectRef)); patch.set("set", set); patch.set("removed", removed);
        update.set("propertyPatch", patch);
    }else update.set("entity", worldEntity(row));
    return update;
}
// Cursor transitions keep catalog order. Source adoption can reorder the
// retained identities; send their references only when that actually happens.
val worldDelta(const ResolvedWorld& before, const ResolvedWorld& after, std::uint32_t baseEpoch,
               std::uint32_t sourceEpoch, bool allowReorder = false) {
    auto value = val::object(), upserts = val::array(), removed = val::array();
    unsigned upsertIndex = 0, removedIndex = 0;
    std::vector<const ObjectRef*> retained;
    const bool changed = before.projection!=after.projection;
    const bool indexed = changed&&!allowReorder&&after.projection->deltaBase.lock()==before.projection;
    if (indexed) {
        std::vector<std::size_t> changedIndices;
        for (const auto& ref:after.projection->affected) {
            const auto* previous = before.find(ref);
            const auto* row = after.find(ref);
            if (!row) {if (previous)removed.set(removedIndex++, object(ref)); continue;}
            if (!previous||!sameWorldEntity(*previous, *row))changedIndices.push_back(after.offsets().at(ref));
        }
        std::sort(changedIndices.begin(), changedIndices.end());
        for (const auto index:changedIndices) {
            const auto& row = after.entities()[index];
            upserts.set(upsertIndex++, worldUpdate(row, before.find(row.objectRef), index, true));
        }
    }
    if (allowReorder&&changed)retained.reserve(after.entities().size());
    std::size_t previousIndex = 0;
    bool havePrevious = false, reordered = false;
    if (changed&&!indexed)for (unsigned i = 0; i<after.entities().size(); ++i) {
        const auto& row = after.entities()[i]; const auto* previous = before.find(row.objectRef);
        if (previous&&sameWorldEntity(*previous, row)) {
            if (allowReorder) {
                const auto index = before.offsets().at(previous->objectRef);
                if (havePrevious&&index<previousIndex)reordered = true;
                previousIndex = index; havePrevious = true; retained.push_back(&row.objectRef);
            }
            continue;
        }
        upserts.set(upsertIndex++, worldUpdate(row, previous, i, !allowReorder));
    }
    if (changed&&!indexed)for (const auto& row:before.entities())if (!after.find(row.objectRef))removed.set(removedIndex++, object(row.objectRef));
    if (reordered) {
        auto order = val::array(); unsigned i = 0;
        for (const auto* ref:retained)order.set(i++, object(*ref));
        value.set("retainedOrder", order);
    }
    value.set("month", after.month); value.set("baseEpoch", baseEpoch); value.set("sourceEpoch", sourceEpoch);
    value.set("entityCount", double(after.entities().size())); value.set("upserts", upserts); value.set("removed", removed);
    return value;
}
val documentState(const DocumentSessionState& state) {
    auto value = val::object(); value.set("epoch", state.epoch); value.set("stateRevision", state.stateRevision);
    value.set("revision", static_cast<double>(state.revision));
    value.set("timelineCursor", state.timelineCursor);
    value.set("presentationRevision", static_cast<double>(state.presentationRevision));
    auto dirtyIds = val::array(); unsigned dirtyIndex = 0; for (const auto& id:state.dirtyTerritorialIds)dirtyIds.set(dirtyIndex++, webString(id)); value.set("dirtyTerritorialIds", dirtyIds);
    value.set("timelineEditsEnabled", state.timelineEditsEnabled); value.set("storageBaselineId", state.storageBaselineId); return value;
}
val selectionValue(const SelectionRef& ref) {
    auto value = val::object(); value.set("domain", webString(ref.domain)); value.set("type", webString(ref.type)); value.set("id", webString(ref.id)); return value;
}
val selectionSnapshot(const SelectionState& selection) {
    auto value = val::object(), items = val::array(); unsigned i = 0;
    for (const auto& ref:selection.items())items.set(i++, selectionValue(ref));
    value.set("selectionRevision", static_cast<double>(selection.revision()));
    value.set("hoverRevision", static_cast<double>(selection.hoverRevision())); value.set("items", items);
    value.set("primary", selection.primary()?selectionValue(*selection.primary()):val::null());
    value.set("hover", selection.hover()?selectionValue(*selection.hover()):val::null()); return value;
}
SelectionRef selectionRef(const val& value) {
    if (value.isNull()||value.isUndefined()||!type(value,"object"))return {};
    const auto field = [&](const char* key) {return type(value[key],"string")?trimWebText(text(value[key],"CORE_SELECTION_REF", true)):std::string{};};
    SelectionRef ref{field("domain"), field("type"), field("id")};
    if (!ref.domain.empty()&&!ref.type.empty()&&!ref.id.empty())(void)selectionRefKey(ref);
    return ref;
}
std::vector<SelectionRef> selectionRefs(const val& value) {
    array(value,"CORE_SELECTION_REF"); std::vector<SelectionRef> result;
    for (unsigned i = 0; i<value["length"].as<unsigned>(); ++i)result.push_back(selectionRef(value[i])); return result;
}
std::vector<SelectionCatalogEntry> readCatalogEntries(const std::string& domain, const val& rows) {
    array(rows,"CORE_SELECTION_CATALOG"); std::vector<SelectionCatalogEntry> entries;
    const auto count = rows["length"].as<unsigned>(); entries.reserve(count);
    for (unsigned i = 0; i<count; ++i) {
        const auto row = rows[i]; std::optional<std::string> logicalId; std::vector<std::string> sourceIds;
        if (!row["logicalId"].isUndefined())logicalId = text(row["logicalId"],"CORE_SELECTION_CATALOG");
        if (domain=="hydroBuiltin") {
            const auto sources = row["sourceIds"]; array(sources,"CORE_SELECTION_CATALOG");
            const auto length = sources["length"].as<unsigned>(); sourceIds.reserve(length);
            for (unsigned j = 0; j<length; ++j)sourceIds.push_back(text(sources[j],"CORE_SELECTION_CATALOG"));
        }
        entries.push_back({selectionRef(row), std::move(logicalId), std::move(sourceIds)});
    }
    return entries;
}
val commandOutcome(const DocumentSessionOutcome& outcome, const DocumentSession& session) {
    auto value = val::object(); value.set("ok", outcome.result.ok());
    value.set("changed", outcome.result.changed()||outcome.candidateId!=0);
    value.set("candidateId", outcome.candidateId); value.set("state", documentState(session.projectState()));
    value.set("selection", selectionSnapshot(session.selection()));
    const char* status = outcome.result.status==CommandStatus::Applied?"applied"
        :outcome.result.status==CommandStatus::NoOp?"noop":"rejected";
    value.set("status", std::string(status));
    if (!outcome.result.ok()) {
        auto error = val::object(); error.set("code", outcome.domainErrorCode.empty()?std::string(commandErrorCode(outcome.result.error)):outcome.domainErrorCode);
        error.set("message", outcome.result.detail); value.set("error", error);
    }else value.set("error", val::null());
    if (!outcome.delta.empty()) {
        auto delta = val::global("JSON").call<val>("parse", outcome.delta); const auto presentation = delta["presentation"];
        if (!presentation.isNull()&&!presentation.isUndefined()) {
            auto settings = presentation["labelSettings"];
            for (const auto& [ref, setting]:session.project().document().presentation.webPresentation.labelSettings)
                if (setting.maxZoom&&*setting.maxZoom==INFINITY) {
                    const auto key = webString(ref.domain+":"+ref.id);
                    if (val::global("Object").call<bool>("hasOwn", settings, key)) {
                        auto row = settings[key]; row.set("maxZoom", INFINITY); settings.set(key, row);
                    }
                }
        }
        value.set("delta", delta);
    }
    return value;
}
projectcodec::PlatformPorts documentPorts(const val& options) {
    if (options.isNull()||!type(options,"object")||!type(options["validateFlagDataUrl"],"function"))
        fail("CODEC_PLATFORM_REQUIRED","A synchronous flag validator is required.");
    const auto validator = options["validateFlagDataUrl"];
    return {[validator](const std::string& url) {
        const auto result = validator(webString(url));
        if (!result.isUndefined()&&!result.isNull()&&type(result,"object")&&type(result["then"],"function"))
            fail("CODEC_PLATFORM_ASYNC","The flag validator must finish before preparing a candidate.");
        if (type(result,"boolean")&&!result.as<bool>())fail("INVALID_FLAG","The platform rejected the flag.");
    }, true, codecjson::ParsedTextPolicy::PreserveUtf16};
}
std::uint32_t commandEpoch(const val& input) {
    const auto value = input["expectedEpoch"];
    if (!type(value,"number"))fail("CORE_COMMAND_EPOCH","An integer epoch is required.");
    const auto epoch = value.as<double>();
    if (!std::isfinite(epoch)||std::floor(epoch)!=epoch||epoch<0||epoch>4294967295.0)fail("CORE_COMMAND_EPOCH","Invalid epoch.");
    return static_cast<std::uint32_t>(epoch);
}
// WASM is a borrowing boundary, never a byte-buffer owner. Copy the
// caller's Uint8Array into a native RAII value before any C++ validation.
projectcodec::WebStorageAssetSource temporalSourceBytes(val input) {
    constexpr const char* code = "CORE_TEMPORAL_SOURCE_ARGS";
    shape(input, {"kind","sourceBytes","encoding","compressedBytes","decodedBytes",
        "baseDataset","sourceMonth","fingerprint"}, code);
    if (text(input["kind"], code)!="stored-asset")
        fail(code,"Only verified stored-asset source bytes are accepted.");
    const auto bytes = input["sourceBytes"];
    if (!bytes.instanceof(val::global("Uint8Array")))
        fail(code,"The source must own a Uint8Array.");
    const auto size = bytes["length"].as<double>();
    if (!std::isfinite(size)||std::floor(size)!=size||size<=0||size>256.0*1024*1024)
        fail(code,"Source buffer size exceeds the verified compressed limit.");
    projectcodec::WebStorageAssetSource source;
    source.sourceBytes.resize(static_cast<std::size_t>(size));
    val view(emscripten::typed_memory_view(source.sourceBytes.size(), source.sourceBytes.data()));
    view.call<void>("set", bytes);
    source.encoding = text(input["encoding"], code);
    source.baseDataset = text(input["baseDataset"], code);
    source.sourceMonth = text(input["sourceMonth"], code);
    source.fingerprint = text(input["fingerprint"], code);
    source.compressedBytes = static_cast<std::uint64_t>(integer(input["compressedBytes"], code));
    source.decodedBytes = static_cast<std::uint64_t>(integer(input["decodedBytes"], code));
    return source;
}
std::uint32_t temporalHandle(const val& input, const char* code) {
    if (!type(input,"number"))fail(code,"A positive uint32 handle is required.");
    const double n = input.as<double>();
    if (!std::isfinite(n)||std::floor(n)!=n||n<1||n>4294967295.0)
        fail(code,"Invalid Core-owned temporal handle.");
    return static_cast<std::uint32_t>(n);
}
std::uint64_t geometryCacheBudget(const val& options) {
    if (options["geometryCacheBytes"].isUndefined())return 64ull*1024*1024;
    const auto budget = integer(options["geometryCacheBytes"],"INVALID_GEOMETRY_CACHE_BUDGET");
    if (budget<0)fail("INVALID_GEOMETRY_CACHE_BUDGET","A nonnegative byte budget is required.");
    return static_cast<std::uint64_t>(budget);
}
class WasmDocumentSession {
public:
    explicit WasmDocumentSession(val options):ports_(documentPorts(options)), session_(ports_, geometryCacheBudget(options)) {}
    val documentLoad(const std::string& input, const std::string& currentMonth) {return boundary([&]{return documentState(session_.documentLoad(input, currentMonth));});}
    val storageBaselineLoad(val input, std::uint32_t epoch) {
        return boundary([&]{const auto kind = text(input["kind"],"CORE_STORAGE_BASELINE");
            if (kind=="static-features") {
                shape(input, {"kind","baseDataset","fingerprint","features"},"CORE_STORAGE_BASELINE");
                auto facts = codecjson::parse(val::global("JSON").call<val>("stringify", input).as<std::string>()); facts.object.erase("kind");
                return documentState(session_.storageBaselineLoad(facts, epoch));
            }
            if (kind!="stored-asset")fail("CORE_STORAGE_BASELINE","An explicit stored-asset or static-features source kind is required.");
            shape(input, {"kind","sourceBytes","encoding","compressedBytes","decodedBytes","baseDataset","sourceMonth","fingerprint"},"CORE_STORAGE_BASELINE");
            const auto bytes = input["sourceBytes"]; if (!bytes.instanceof(val::global("Uint8Array")))fail("CORE_STORAGE_BASELINE","Stored asset bytes must be a Uint8Array.");
            const auto size = bytes["length"].as<double>(); if (size>256*1024*1024)fail("CORE_STORAGE_BASELINE","Stored asset exceeds its compressed size bound.");
            projectcodec::WebStorageAssetSource source; source.sourceBytes.resize(static_cast<std::size_t>(size));
            val view(emscripten::typed_memory_view(source.sourceBytes.size(), source.sourceBytes.data())); view.call<void>("set", bytes);
            source.encoding = text(input["encoding"],"CORE_STORAGE_BASELINE"); source.baseDataset = text(input["baseDataset"],"CORE_STORAGE_BASELINE");
            source.sourceMonth = text(input["sourceMonth"],"CORE_STORAGE_BASELINE"); source.fingerprint = text(input["fingerprint"],"CORE_STORAGE_BASELINE");
            source.compressedBytes = static_cast<std::uint64_t>(integer(input["compressedBytes"],"CORE_STORAGE_BASELINE"));
            source.decodedBytes = static_cast<std::uint64_t>(integer(input["decodedBytes"],"CORE_STORAGE_BASELINE"));
            return documentState(session_.storageBaselineLoad(source, epoch));
        });
    }

    val temporalSourcePrepare(val input) {
        return boundary([&] {
            shape(input, {"source","dataRevision","manifestSha256","expectedEpoch"},"CORE_TEMPORAL_SOURCE_ARGS");
            const auto receipt = session_.temporalSourcePrepare(temporalSourceBytes(input["source"]),
                text(input["dataRevision"],"CORE_TEMPORAL_SOURCE_ARGS"),
                text(input["manifestSha256"],"CORE_TEMPORAL_SOURCE_ARGS"), commandEpoch(input));
            auto result = val::object();
            result.set("sourceId", receipt.sourceId);
            result.set("sourceMonth", webString(receipt.sourceMonth));
            result.set("fingerprint", webString(receipt.fingerprint));
            result.set("reused", receipt.reused);
            return result;
        });
    }
    val temporalSourceStats() const {
        return boundary([&] {
            const auto stats = session_.temporalSourceStats();
            auto result = val::object();
            result.set("entries", static_cast<double>(stats.entries));
            result.set("declaredDecodedBytes", static_cast<double>(stats.declaredDecodedBytes));
            result.set("hits", static_cast<double>(stats.hits));
            result.set("evictions", static_cast<double>(stats.evictions));
            return result;
        });
    }
    bool temporalSourceRelease(val input) {
        return boundary([&] {
            shape(input, {"sourceId","expectedEpoch"},"CORE_TEMPORAL_SOURCE_ARGS");
            return session_.temporalSourceRelease(temporalHandle(input["sourceId"],"CORE_TEMPORAL_SOURCE_ARGS"),
                commandEpoch(input));
        });
    }
    val temporalCandidatePrepare(val input) {
        return boundary([&] {
            shape(input, {"sourceId","targetMonth","sourceFingerprint","expectedEpoch",
                "setup","documentId"},"CORE_TEMPORAL_CANDIDATE_ARGS");
            std::optional<codecjson::Value> setup;
            if (!input["setup"].isNull()) {
                const auto json = val::global("JSON").call<val>("stringify", input["setup"]);
                if (!type(json,"string"))fail("CORE_TEMPORAL_CANDIDATE_ARGS","A project setup object is required.");
                setup = codecjson::parse(json.as<std::string>());
            }
            const auto receipt = session_.temporalCandidatePrepare(
                temporalHandle(input["sourceId"],"CORE_TEMPORAL_CANDIDATE_ARGS"),
                text(input["targetMonth"],"CORE_TEMPORAL_CANDIDATE_ARGS"),
                text(input["sourceFingerprint"],"CORE_TEMPORAL_CANDIDATE_ARGS"),
                commandEpoch(input), setup, text(input["documentId"],"CORE_TEMPORAL_CANDIDATE_ARGS", true));
            auto result = val::object();
            result.set("candidateId", receipt.candidateId);
            result.set("sourceId", receipt.sourceId);
            result.set("expectedEpoch", receipt.expectedEpoch);
            result.set("targetMonth", webString(receipt.targetMonth));
            result.set("sourceFingerprint", webString(receipt.sourceFingerprint));
            result.set("worldSha256", webString(receipt.worldSha256));
            result.set("resolvedEntityCount", static_cast<double>(receipt.resolvedEntityCount));
            result.set("reused", receipt.reused);
            return result;
        });
    }
    val temporalCandidateInspect(val input) const {
        return boundary([&] {
            shape(input, {"candidateId","expectedEpoch"},"CORE_TEMPORAL_CANDIDATE_ARGS");
            const auto inspected = session_.temporalCandidateInspect(
                temporalHandle(input["candidateId"],"CORE_TEMPORAL_CANDIDATE_ARGS"), commandEpoch(input));
            if (!inspected)return val::null();
            auto result = val::object();
            result.set("project", val::global("JSON").call<val>("parse", inspected->projectedJson));
            result.set("world", world(inspected->world));
            return result;
        });
    }
    bool temporalCandidateDiscard(val input) {
        return boundary([&] {
            shape(input, {"candidateId","expectedEpoch"},"CORE_TEMPORAL_CANDIDATE_ARGS");
            return session_.temporalCandidateDiscard(
                temporalHandle(input["candidateId"],"CORE_TEMPORAL_CANDIDATE_ARGS"), commandEpoch(input));
        });
    }
    val temporalCandidateAdopt(val input) {
        return boundary([&] {
            shape(input, {"candidateId","sourceId","targetMonth","sourceFingerprint","worldSha256",
                "replacementId","expectedEpoch"},"CORE_TEMPORAL_CANDIDATE_ARGS");
            std::string delta;
            std::shared_ptr<const ResolvedWorld> previousWorld;
            const auto epoch = commandEpoch(input);
            const auto adopted = session_.temporalCandidateAdopt(
                temporalHandle(input["candidateId"],"CORE_TEMPORAL_CANDIDATE_ARGS"),
                temporalHandle(input["sourceId"],"CORE_TEMPORAL_CANDIDATE_ARGS"),
                text(input["targetMonth"],"CORE_TEMPORAL_CANDIDATE_ARGS"),
                text(input["sourceFingerprint"],"CORE_TEMPORAL_CANDIDATE_ARGS"),
                text(input["worldSha256"],"CORE_TEMPORAL_CANDIDATE_ARGS"),
                temporalHandle(input["replacementId"],"CORE_TEMPORAL_CANDIDATE_ARGS"),
                epoch, &delta, &previousWorld);
            auto result = val::object(); result.set("state", documentState(adopted));
            result.set("delta", delta.empty()?val::null():val::global("JSON").call<val>("parse", delta));
            if (previousWorld) {
                const auto next = session_.resolveWorldShared(adopted.timelineCursor);
                result.set("worldDelta", worldDelta(*previousWorld, *next, epoch, adopted.epoch, true));
            }
            return result;
        });
    }
    val admitExternalBaseline(std::uint32_t epoch) {return boundary([&]{return documentState(session_.admitExternalBaseline(epoch));});}
    val baselineCoverage(std::uint32_t id, const std::string& month) const {return boundary([&]{const auto resolved = session_.baselineWorld(id, month); auto result = val::object(); result.set("month", month); result.set("available", resolved.entities().size()); return result;});}
    val documentLoadBaseline(std::uint32_t id, const val& setup) {return boundary([&]{return documentState(session_.documentLoadBaseline(id, codecjson::parse(val::global("JSON").call<val>("stringify", setup).as<std::string>()), val::global("crypto").call<val>("randomUUID").as<std::string>()));});}
    val documentInitialize(val input) {
        return boundary([&]{std::optional<codecjson::Value> features; std::optional<std::string> source;
            if (!input["features"].isUndefined())features = codecjson::parse(val::global("JSON").call<val>("stringify", input["features"]).as<std::string>());
            if (!input["territorialSource"].isUndefined())source = val::global("JSON").call<val>("stringify", input["territorialSource"]).as<std::string>();
            if (!type(input["preserveCursor"],"boolean"))fail("CORE_SOURCE_ADMISSION","A preserveCursor boolean is required.");
            const auto project = input["project"].isUndefined()?std::string{}:val::global("JSON").call<val>("stringify", input["project"]).as<std::string>();
            std::optional<std::uint32_t> baseline; if (!input["baselineId"].isUndefined())baseline = static_cast<std::uint32_t>(integer(input["baselineId"],"CORE_STORAGE_BASELINE"));
            return documentState(session_.documentInitialize(project, text(input["currentMonth"],"CORE_SOURCE_ADMISSION"), input["preserveCursor"].as<bool>(), features, source, commandEpoch(input), baseline));
        });
    }
    val documentSnapshot() const {
        return boundary([&]{auto value = val::global("JSON").call<val>("parse", session_.documentSnapshot());
            auto settings = value["labelSettings"];
            for (const auto& [ref, setting]:session_.project().document().presentation.webPresentation.labelSettings)
                if (setting.maxZoom&&*setting.maxZoom==INFINITY) {
                    const auto key = webString(ref.domain+":"+ref.id); auto row = settings[key]; row.set("maxZoom", INFINITY); settings.set(key, row);
                }
            return value;
        });
    }
    std::uint32_t captureReplacement(std::uint32_t epoch) {return boundary([&]{return session_.captureReplacement(epoch);});}
    val rollbackReplacement(std::uint32_t id, std::uint32_t epoch) {return boundary([&]{return documentState(session_.rollbackReplacement(id, epoch));});}
    bool releaseReplacement(std::uint32_t id) {return session_.releaseReplacement(id);}
    std::string storageSnapshot() const{return boundary([&]{return session_.storageSnapshot();});}
    val projectState() const{return boundary([&]{return documentState(session_.projectState());});}
    val resolveWorld(const std::string& month, std::uint32_t epoch) const {
        return boundary([&]{session_.requireEpoch(epoch); auto value = world(*session_.resolveWorldShared(month)); value.set("sourceEpoch", epoch); return value;});
    }
    val geometryRequirements(const std::string& month, std::uint32_t epoch) const {
        return boundary([&]{auto rows = val::array(); unsigned i = 0;
            for (const auto& ref:session_.geometryRequirements(month, epoch)) {
                const auto& resource = session_.project().document().geometries.resources().at(ref); auto row = val::object();
                row.set("id", webString(ref.id)); row.set("version", ref.version); row.set("type", resource.type);
                row.set("contentSha256", resource.contentSha256); row.set("decodedBytes", double(resource.decodedBytes)); rows.set(i++, row);
            }
            auto result = val::object(); result.set("resources", rows); result.set("sourceEpoch", epoch); return result;});
    }
    val admitGeometryResources(val payloads, std::uint32_t epoch, const std::string& month) {
        return boundary([&]{array(payloads,"INVALID_GEOMETRY_RESOURCE"); std::vector<std::pair<GeometryRef, std::string>> rows;
            for (unsigned i = 0; i<payloads["length"].as<unsigned>(); ++i) {const auto row = payloads[i]; shape(row, {"id","version","source"},"INVALID_GEOMETRY_RESOURCE");
                rows.push_back({{text(row["id"],"INVALID_GEOMETRY_RESOURCE"), temporalHandle(row["version"],"INVALID_GEOMETRY_RESOURCE")}, text(row["source"],"INVALID_GEOMETRY_RESOURCE")});}
            const auto delta = session_.admitGeometryResources(rows, epoch, month);
            auto result = val::object(), geometryDelta = val::object(), admitted = val::array(), removed = val::array();
            unsigned i = 0; for (const auto& ref:delta.admitted)admitted.set(i++, geometry(ref));
            i = 0; for (const auto& ref:delta.evicted)removed.set(i++, geometry(ref));
            geometryDelta.set("admitted", admitted); geometryDelta.set("removed", removed);
            result.set("state", documentState(session_.projectState())); result.set("geometryDelta", geometryDelta); return result;
        });
    }
    val setTimelineCursor(const std::string& month, std::uint32_t epoch) {
        return boundary([&]{
            session_.requireEpoch(epoch);
            const auto before = session_.resolveWorldShared(session_.project().timelineCursor());
            std::shared_ptr<const ResolvedWorld> resolved;
            std::vector<GeometryRef> evicted;
            session_.setTimelineCursor(month, epoch, &resolved, &evicted);
            const auto state = session_.projectState();
            auto result = val::object();
            result.set("state", documentState(state));
            result.set("selection", ::selectionSnapshot(session_.selection()));
            result.set("worldDelta", worldDelta(*before, *resolved, epoch, state.epoch));
            auto geometryDelta = val::object(), removed = val::array();
            unsigned i = 0; for (const auto& ref:evicted)removed.set(i++, geometry(ref));
            geometryDelta.set("admitted", val::array()); geometryDelta.set("removed", removed);
            result.set("geometryDelta", geometryDelta);
            return result;
        });
    }
    val selectionCatalogLoad(const std::string& domain, val rows, std::uint32_t epoch) {
        return boundary([&]{return commandOutcome(session_.selectionCatalogLoad(domain, readCatalogEntries(domain, rows), epoch), session_);});
    }
    val selectionCatalogPatch(val rows, val removed, std::uint32_t epoch) {
        return boundary([&]{
            const auto removals = selectionRefs(removed);
            return commandOutcome(session_.selectionCatalogLoad("hydroBuiltin", readCatalogEntries("hydroBuiltin", rows), epoch, &removals), session_);
        });
    }
    val presentationCatalogLoad(val input, std::uint32_t epoch) {
        return boundary([&]{shape(input, {"hydroLayers","countryLabelIds","builtinSubunitSources"},"CORE_PRESENTATION_CATALOG");
            PresentationCatalog catalog; const auto layers = input["hydroLayers"]; const auto ids = val::global("Object").call<val>("keys", layers);
            for (unsigned i = 0; i<ids["length"].as<unsigned>(); ++i) {const auto key = ids[i]; catalog.hydroLayers.emplace(text(key,"CORE_PRESENTATION_CATALOG"), text(layers[key],"CORE_PRESENTATION_CATALOG"));}
            const auto labels = input["countryLabelIds"]; array(labels,"CORE_PRESENTATION_CATALOG");
            for (unsigned i = 0; i<labels["length"].as<unsigned>(); ++i)catalog.countryLabelIds.push_back(text(labels[i],"CORE_PRESENTATION_CATALOG"));
            const auto sources = input["builtinSubunitSources"]; if (sources.isNull()||!type(sources,"object")||val::global("Array").call<bool>("isArray", sources))
                fail("CORE_PRESENTATION_CATALOG","A builtin subunit source map is required.");
            const auto sourceIds = val::global("Object").call<val>("keys", sources);
            for (unsigned i = 0; i<sourceIds["length"].as<unsigned>(); ++i) {const auto key = sourceIds[i];
                catalog.builtinSubunitSources.emplace(text(key,"CORE_PRESENTATION_CATALOG"), text(sources[key],"CORE_PRESENTATION_CATALOG"));}
            return commandOutcome(session_.presentationCatalogLoad(std::move(catalog), epoch), session_);
        });
    }
    val selectionSnapshot() const{return boundary([&]{session_.projectState(); return ::selectionSnapshot(session_.selection());});}
    val selectionApply(val input) {
        return boundary([&] {
            session_.requireEpoch(commandEpoch(input));
            auto& selection = session_.selection(); const auto action = text(input["action"],"CORE_SELECTION_ACTION");
            bool countNoOp = true;
            const auto scope = type(input["scope"],"string")?text(input["scope"],"CORE_SELECTION_SCOPE", true):std::string{};
            const auto admitted = [&](const SelectionRef& ref) {return session_.selectionRefExists(ref);};
            const auto value = selectionRef(input["ref"]);
            if (action=="replace"||action=="toggle") {
                if (admitted(value)) {if (action=="replace")selection.replace(value, scope); else selection.toggle(value, scope);}
            }else if (action=="selectRange"||action=="setMany") {
                auto refs = selectionRefs(input[action=="selectRange"?"orderedRefs":"refs"]);
                refs.erase(std::remove_if(refs.begin(), refs.end(), [&](const auto& ref) {return !admitted(ref);}), refs.end());
                if (action=="selectRange") {
                    if (admitted(value))selection.selectRange(value, refs, scope.empty()?"default":scope,
                        type(input["additive"],"boolean")&&input["additive"].as<bool>());
                }else {
                    const auto primary = selectionRef(input["primary"]);
                    selection.setMany(refs, admitted(primary)?std::optional<SelectionRef>{primary}:std::nullopt, scope);
                }
            }else if (action=="remove") {
                if (type(input["key"],"string")) {
                    const auto key = text(input["key"],"CORE_SELECTION_KEY", true); const auto items = selection.items();
                    for (const auto& ref:items)if (selectionRefKey(ref)==key) {selection.remove(ref); break;}
                }else selection.remove(value);
            }else if (action=="prune") {
                if (input["validKeys"].isNull()||input["validKeys"].isUndefined())selection.prune(admitted);
                else {const auto rows = input["validKeys"]; array(rows,"CORE_SELECTION_KEYS"); std::set<std::string> keys;
                    for (unsigned i = 0; i<rows["length"].as<unsigned>(); ++i)keys.insert(text(rows[i],"CORE_SELECTION_KEYS", true));
                    selection.prune([&](const auto& ref) {return keys.count(selectionRefKey(ref))!=0;});}
            }else if (action=="clear")selection.clear();
            else if (action=="resetProject")selection.resetProject();
            else if (action=="setHover") {
                const auto source = type(input["source"],"string")?text(input["source"],"CORE_SELECTION_SOURCE", true):std::string{};
                const auto key = type(input["expectedKey"],"string")?text(input["expectedKey"],"CORE_SELECTION_KEY", true):std::string{};
                if (input["ref"].isNull()||input["ref"].isUndefined())countNoOp = selection.setHover({}, source, key);
                else if (admitted(value))selection.setHover(value, source, key);
            }else fail("CORE_SELECTION_ACTION","Unknown selection action: "+action);
            auto result = val::object(); result.set("selection", ::selectionSnapshot(selection)); result.set("countNoOp", countNoOp); return result;
        });
    }
private:
    projectcodec::PlatformPorts ports_;
    DocumentSession session_;
};
}
EMSCRIPTEN_BINDINGS(pandoeditor_document_session) {
    const auto compilerVersion = std::to_string(__EMSCRIPTEN_major__)+"."
        +std::to_string(__EMSCRIPTEN_minor__)+"."+std::to_string(__EMSCRIPTEN_tiny__);
    emscripten::constant("coreAbiVersion", 1);
    emscripten::constant("coreSourceSha256", std::string(PANDOEDITOR_CORE_SOURCE_SHA256));
    emscripten::constant("coreCompilerVersion", compilerVersion);
    registerDocumentCalculationBindings();
    emscripten::class_<WasmDocumentSession>("DocumentSession").constructor<val>()
        .function("documentLoad", &WasmDocumentSession::documentLoad).function("storageSnapshot", &WasmDocumentSession::storageSnapshot)
        .function("storageBaselineLoad", &WasmDocumentSession::storageBaselineLoad)
        .function("temporalSourcePrepare", &WasmDocumentSession::temporalSourcePrepare)
        .function("temporalSourceStats", &WasmDocumentSession::temporalSourceStats)
        .function("temporalSourceRelease", &WasmDocumentSession::temporalSourceRelease)
        .function("temporalCandidatePrepare", &WasmDocumentSession::temporalCandidatePrepare)
        .function("temporalCandidateInspect", &WasmDocumentSession::temporalCandidateInspect)
        .function("temporalCandidateDiscard", &WasmDocumentSession::temporalCandidateDiscard)
        .function("temporalCandidateAdopt", &WasmDocumentSession::temporalCandidateAdopt)
        .function("baselineCoverage", &WasmDocumentSession::baselineCoverage).function("documentLoadBaseline", &WasmDocumentSession::documentLoadBaseline).function("admitExternalBaseline", &WasmDocumentSession::admitExternalBaseline)
        .function("documentInitialize", &WasmDocumentSession::documentInitialize).function("documentSnapshot", &WasmDocumentSession::documentSnapshot)
        .function("captureReplacement", &WasmDocumentSession::captureReplacement).function("rollbackReplacement", &WasmDocumentSession::rollbackReplacement)
        .function("releaseReplacement", &WasmDocumentSession::releaseReplacement)
        .function("projectState", &WasmDocumentSession::projectState)
        .function("resolveWorld", &WasmDocumentSession::resolveWorld).function("setTimelineCursor", &WasmDocumentSession::setTimelineCursor)
        .function("geometryRequirements", &WasmDocumentSession::geometryRequirements).function("admitGeometryResources", &WasmDocumentSession::admitGeometryResources)
        .function("selectionCatalogLoad", &WasmDocumentSession::selectionCatalogLoad)
        .function("selectionCatalogPatch", &WasmDocumentSession::selectionCatalogPatch)
        .function("selectionApply", &WasmDocumentSession::selectionApply)
        .function("presentationCatalogLoad", &WasmDocumentSession::presentationCatalogLoad)
        .function("selectionSnapshot", &WasmDocumentSession::selectionSnapshot);
}
