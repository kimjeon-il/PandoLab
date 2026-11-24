#pragma once
#include <pandoeditor/timeline-records.h>
#include <pandoeditor/temporal.h>
#include <map>
#include <memory>
#include <iterator>
#include <set>

namespace pandoeditor {
using ResolvedProperties=std::map<std::string,std::string>;
struct ResolvedEntity {
    ObjectRef objectRef;
    GeometryRef geometryRef;
    std::string rendering="{}";
    std::string parentId, coverageMode, rootId;
    std::vector<std::string> ancestors;
    Validity validity;
    std::shared_ptr<const ResolvedProperties> propertyValues;
    const ResolvedProperties& properties() const noexcept {
        static const ResolvedProperties empty;
        return propertyValues?*propertyValues:empty;
    }
};
using ResolvedEntityStorage=std::vector<std::shared_ptr<const ResolvedEntity>>;
using ResolvedOffsets=std::map<ObjectRef,std::size_t>;
using ResolvedPropertyIndex=std::map<ObjectRef,std::shared_ptr<const ResolvedProperties>>;
using ResolvedGeometryUsers=std::map<GeometryRef,std::size_t>;
using ResolvedChildren=std::map<std::string,std::set<ObjectRef>>;
// A read-only ordered range preserves the existing consumers' row interface
// without making a second contiguous copy of shared entities.
struct ResolvedEntityRange {
    const ResolvedEntityStorage& rows;
    struct Iterator {
        using iterator_category=std::forward_iterator_tag;
        using value_type=ResolvedEntity;
        using difference_type=std::ptrdiff_t;
        using pointer=const ResolvedEntity*;
        using reference=const ResolvedEntity&;
        ResolvedEntityStorage::const_iterator it;
        reference operator*() const {return **it;}
        pointer operator->() const {return it->get();}
        Iterator& operator++(){++it;return *this;}
        Iterator operator++(int){auto prior=*this;++*this;return prior;}
        bool operator==(const Iterator& other) const {return it==other.it;}
        bool operator!=(const Iterator& other) const {return !(*this==other);}
    };
    Iterator begin() const {return {rows.begin()};}
    Iterator end() const {return {rows.end()};}
    std::size_t size() const noexcept {return rows.size();}
    bool empty() const noexcept {return rows.empty();}
    const ResolvedEntity& operator[](std::size_t index) const {return *rows[index];}
    const ResolvedEntity& at(std::size_t index) const {return *rows.at(index);}
    const ResolvedEntity& front() const {return *rows.front();}
    const ResolvedEntity& back() const {return *rows.back();}
};
// The cursor is a small value; its resolved projection is immutable and
// shared by every event-free month, view, and detached candidate that owns it.
struct ResolvedWorldProjection {
    ResolvedEntityStorage entities;
    std::weak_ptr<const void> sourceIdentity;
    std::size_t intervalId=0;
    std::shared_ptr<const ResolvedOffsets> offsets=std::make_shared<const ResolvedOffsets>();
    // Share the whole index when a cursor changes no corresponding entries.
    std::shared_ptr<const ResolvedPropertyIndex> activeProperties=std::make_shared<const ResolvedPropertyIndex>();
    std::shared_ptr<const ResolvedGeometryUsers> geometryUsers=std::make_shared<const ResolvedGeometryUsers>();
    std::shared_ptr<const ResolvedChildren> children=std::make_shared<const ResolvedChildren>();
    std::shared_ptr<const std::vector<GeometryRef>> requiredGeometries=std::make_shared<const std::vector<GeometryRef>>();
    // A weak receipt cannot pin previous months. Only a matching base may
    // use the affected owner set to skip the full wire comparison.
    std::weak_ptr<const ResolvedWorldProjection> deltaBase;
    std::vector<ObjectRef> affected;
};
struct ResolvedWorld {
    std::string month;
    std::shared_ptr<const ResolvedWorldProjection> projection=std::make_shared<const ResolvedWorldProjection>();
    ResolvedEntityRange entities() const noexcept {return {projection->entities};}
    const auto& offsets() const noexcept {return *projection->offsets;}
    const auto& activeProperties() const noexcept {return *projection->activeProperties;}
    const auto& requiredGeometries() const noexcept {return *projection->requiredGeometries;}
    const ResolvedEntity* find(const ObjectRef&) const;
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
    std::size_t intervalId(const TemporalKey&) const;
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
