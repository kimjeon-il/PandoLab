#include <pandoeditor/timeline-storage.h>

namespace pandoeditor {
namespace {
TimelineRecords validated(const TimelineRecords& records, const GeometryStore& geometries,
                          const std::vector<TimelineEntityIdentity>& entities) {
    return normalizeTimelineRecords(records, {entities, [&geometries](const ObjectRef&, const GeometryRef& ref) {
        return geometries.type(ref);
    }});
}
}

TimelineStorage restoreTimelineStorage(const TimelineStorageSnapshot& input,
                                      const std::vector<TimelineEntityIdentity>& entities) {
    if (input.schemaVersion!=TimelineStorageSchemaVersion)
        throw TimelineError("TIMELINE_STORAGE_SCHEMA","Unsupported storage version.");
    TimelineStorage candidate;
    for (const auto& [ref, resource]:input.resources)candidate.geometries.declareResource(ref, resource);
    for (const auto& value:input.geometries) {
        if (!value.geometry) throw std::invalid_argument("INVALID_GEOMETRY: missing geometry allocation");
        // Reuse the canonical geometry owner's validation and duplicate-version rules.
        // Copy input coordinates so even an external mutable alias cannot alter the result.
        candidate.geometries.insertCanonical(value.ref, *value.geometry);
    }
    candidate.records = validated(input.records, candidate.geometries, entities);
    return candidate;
}
}
