#pragma once
#include <pandoeditor/timeline-records.h>
#include <pandoeditor/temporal.h>
#include <map>
#include <memory>

namespace pandoeditor {
struct ResolvedEntity {
    ObjectRef objectRef;
    GeometryRef geometryRef;
    std::string rendering="{}";
    std::string parentId, coverageMode, rootId;
    std::vector<std::string> ancestors;
    Validity validity;
    std::map<std::string,std::string> properties;
};
struct ResolvedWorld {
    std::string month;
    std::vector<ResolvedEntity> entities;
    // Stable index positions survive copies of the resolved world.
    std::map<ObjectRef,std::size_t> offsets;
    // Active values include identities without currently visible geometry.
    std::map<ObjectRef,std::map<std::string,std::string>> activeProperties;
    const ResolvedEntity* find(const ObjectRef&) const;
    // Populated by the resolver once, reused by admission and projection.
    std::vector<GeometryRef> requiredGeometries;
    // An immutable projection certificate is shared only by exact
    // event-free cursor copies of one prepared timeline source.
    std::shared_ptr<const bool> projectionIdentity;
};

// One inclusive as-of-boundary rule for project and library object histories.
bool validityContainsAtEnd(const Validity&,const TemporalValue&);
std::optional<std::size_t> selectTimelineVersion(const Validity& lifetime,
    const std::vector<Validity>& versions,const std::optional<std::string>& referenceDate);
enum class HistoricalSourceAvailability { Available,GeometryGap,Absent,Unknown };
HistoricalSourceAvailability classifyHistoricalSourceAvailability(const Validity& lifetime,
    const std::vector<Validity>& versions,const std::string& referenceDate);

// Normalize and validate once per immutable document snapshot. Its interval
// indexes own their source records and are safe across subsequent month queries.
class PreparedTimelineWorld {
public:
    PreparedTimelineWorld(const TimelineRecords&,const TimelineValidationContext&);
    // The previous projection must come from this same prepared source.
    ResolvedWorld resolve(const std::string& month,const ResolvedWorld* previous=nullptr) const;
private:
    struct Data;
    std::shared_ptr<const Data> data_;
};

// The input catalog supplies stable identity order; records and geometry are
// validated before the month-end view is assembled.
ResolvedWorld resolveWorld(const TimelineRecords&, const TimelineValidationContext&,
                           const std::string& month);
std::string initialTimelineMonth(const TimelineRecords&,const std::string& currentMonth);
// Connected map-data coverage containing the cursor, across adjacent versions.
// Input records must already be validated; a map-data gap is not a lifetime end.
Validity timelineMapCoverageAtMonth(const TimelineRecords&,const ObjectRef&,const std::string& month);
}
