#include <pandoeditor/timeline-resolver.h>
#include <pandoeditor/temporal.h>
#include <algorithm>
#include <map>
#include <set>

namespace pandoeditor {
bool validityContainsAtEnd(const Validity& validity,const TemporalValue& point) {
    const auto interval=normalizeTemporalInterval(validity.from,validity.to);
    return (!interval.start||compareTemporal(*interval.start,point,TemporalBoundary::Start,TemporalBoundary::End)<=0)
        &&(!interval.end||compareTemporal(*interval.end,point,TemporalBoundary::End,TemporalBoundary::End)>=0);
}
std::optional<std::size_t> selectTimelineVersion(const Validity& lifetime,
    const std::vector<Validity>& versions,const std::optional<std::string>& referenceDate) {
    if(!referenceDate||referenceDate->empty()) {
        if(versions.size()==1&&!lifetime.from&&!lifetime.to
            &&!versions.front().from&&!versions.front().to)return std::size_t{0};
        throw std::invalid_argument("A reference date is required for dated territorial geometry");
    }
    const auto point=parseTemporal(*referenceDate);
    if(!validityContainsAtEnd(lifetime,point))return std::nullopt;
    std::optional<std::size_t> selected;
    for(std::size_t i=0;i<versions.size();++i) {
        if(!validityContainsAtEnd(versions[i],point))continue;
        if(selected)throw TimelineError("PL-LIB-GEOMETRY","Ambiguous territorial geometry selection");
        selected=i;
    }
    return selected;
}
namespace {
template<class Row> struct IndexedRow {
    const Row* value;
    TemporalInterval validity;
};
template<class Row> using RowsByEntity=std::map<ObjectRef,std::vector<IndexedRow<Row>>>;
template<class Row> void sortIntervals(std::vector<IndexedRow<Row>>& rows) {
    std::stable_sort(rows.begin(),rows.end(),[](const auto& a,const auto& b){
        if(!a.validity.start)return bool(b.validity.start);
        if(!b.validity.start)return false;
        return a.validity.start->startKey<b.validity.start->startKey;
    });
}
template<class Row> RowsByEntity<Row> indexRows(const std::vector<Row>& rows) {
    RowsByEntity<Row> index;
    for(const auto& row:rows)
        index[row.objectRef].push_back({&row,normalizeTemporalInterval(row.validity.from,row.validity.to)});
    for(auto& [ref,entries]:index)sortIntervals(entries);
    return index;
}
using PropertyRows=std::map<ObjectRef,std::map<std::string,std::vector<IndexedRow<TimelinePropertyBinding>>>>;
PropertyRows indexProperties(const std::vector<TimelinePropertyBinding>& rows) {
    PropertyRows result;
    for(const auto& row:rows)
        result[row.objectRef][row.property].push_back({&row,normalizeTemporalInterval(row.validity.from,row.validity.to)});
    for(auto& [ref,properties]:result)for(auto& [name,entries]:properties)sortIntervals(entries);
    return result;
}
bool active(const TemporalInterval& interval,const TemporalKey& atEnd) {
    return (!interval.start||!(atEnd<interval.start->startKey))
        &&(!interval.end||!(interval.end->endKey<atEnd));
}
template<class Row> const Row* selectedInterval(const std::vector<IndexedRow<Row>>& rows,
                                                  const TemporalKey& atEnd) {
    // Validation guarantees disjoint intervals within each owner/slot.
    // Only the latest start not after this date can contain it.
    auto it=std::upper_bound(rows.begin(),rows.end(),atEnd,[](const auto& date,const auto& row){
        return row.validity.start&&date<row.validity.start->startKey;
    });
    if(it==rows.begin())return nullptr;
    --it;return active(it->validity,atEnd)?it->value:nullptr;
}
template<class Row> const Row* selected(const RowsByEntity<Row>& index,const ObjectRef& id,
                                       const TemporalKey& atEnd) {
    const auto found=index.find(id);
    return found==index.end()?nullptr:selectedInterval(found->second,atEnd);
}
}
struct PreparedTimelineWorld::Data {
    TimelineRecords records;
    std::vector<TimelineEntityIdentity> entities;
    RowsByEntity<TimelineLifetime> lifetimes;
    RowsByEntity<TimelineGeometryBinding> geometries;
    RowsByEntity<TimelineParentRelation> parents;
    PropertyRows properties;
    // Inclusive interval starts and the day after inclusive ends are the
    // only dates on which an identity's direct projection can change.
    std::map<TemporalKey,std::set<ObjectRef>> events;
};
PreparedTimelineWorld::PreparedTimelineWorld(const TimelineRecords& records,const TimelineValidationContext& context) {
    auto next=std::make_shared<Data>();
    next->records=normalizeTimelineRecords(records,context);
    next->entities=context.entities;
    next->lifetimes=indexRows(next->records.lifetimes);
    next->geometries=indexRows(next->records.geometryBindings);
    next->parents=indexRows(next->records.parentRelations);
    next->properties=indexProperties(next->records.propertyBindings);
    const auto addEvents=[&](const ObjectRef& ref,const auto& entries){
        for(const auto& entry:entries){
            if(entry.validity.start)next->events[entry.validity.start->startKey].insert(ref);
            if(entry.validity.end)next->events[temporalFollowingDay(entry.validity.end->endKey)].insert(ref);
        }
    };
    const auto indexEvents=[&](const auto& rows){for(const auto& [ref,entries]:rows)addEvents(ref,entries);};
    indexEvents(next->lifetimes);indexEvents(next->geometries);indexEvents(next->parents);
    for(const auto& [ref,properties]:next->properties)
        for(const auto& [name,entries]:properties)addEvents(ref,entries);
    data_=std::move(next);
}
const ResolvedEntity* ResolvedWorld::find(const ObjectRef& id) const {
    if(!offsets.empty()) {
        const auto found=offsets.find(id);
        return found==offsets.end()||found->second>=entities.size()?nullptr:&entities[found->second];
    }
    const auto it=std::find_if(entities.begin(),entities.end(),[&](const auto& row){return row.objectRef==id;});
    return it==entities.end()?nullptr:&*it;
}
std::string initialTimelineMonth(const TimelineRecords& records,const std::string& currentMonth) {
    const auto fallback=parseTemporal(currentMonth);
    if(fallback.precision!="month")throw TimelineError("INVALID_TIMELINE_CURSOR","month precision required");
    std::optional<TemporalValue> latest;
    const auto inspect=[&](const auto& rows){for(const auto& row:rows)if(row.validity.from) {
        const auto parsed=parseTemporal(*row.validity.from);
        if(!latest||latest->startKey<parsed.startKey)latest=parsed;
    }};
    inspect(records.lifetimes);inspect(records.geometryBindings);inspect(records.parentRelations);
    if(!latest)return fallback.canonical;
    if(latest->precision=="year")return latest->canonical+"-01";
    if(latest->precision=="date")return latest->canonical.substr(0,latest->canonical.size()-3);
    return latest->canonical;
}
HistoricalSourceAvailability classifyHistoricalSourceAvailability(const Validity& lifetime,
    const std::vector<Validity>& versions,const std::string& referenceDate) {
    if(selectTimelineVersion(lifetime,versions,referenceDate))return HistoricalSourceAvailability::Available;
    const auto point=parseTemporal(referenceDate);
    if(!validityContainsAtEnd(lifetime,point))return HistoricalSourceAvailability::Absent;
    return lifetime.from||lifetime.to?HistoricalSourceAvailability::GeometryGap:HistoricalSourceAvailability::Unknown;
}
Validity timelineMapCoverageAtMonth(const TimelineRecords& records,const ObjectRef& id,const std::string& month) {
    const auto cursor=parseTemporal(month);
    if(cursor.precision!="month")throw TimelineError("INVALID_TIMELINE_CURSOR","month precision required");
    const auto point=temporalMonthEnd(cursor.canonical);
    std::vector<TemporalInterval> intervals;
    for(const auto& row:records.geometryBindings)if(row.objectRef==id)
        intervals.push_back(normalizeTemporalInterval(row.validity.from,row.validity.to));
    std::sort(intervals.begin(),intervals.end(),[](const auto& a,const auto& b) {
        return b.start&&(!a.start||a.start->startKey<b.start->startKey);
    });
    std::optional<TemporalInterval> coverage;
    for(const auto& interval:intervals) {
        if(coverage&&coverage->end&&interval.start&&temporalFollowingDay(coverage->end->endKey)<interval.start->startKey) {
            const Validity value{coverage->validFrom,coverage->validTo};
            if(validityContainsAtEnd(value,point))return value;
            coverage.reset();
        }
        coverage=coverage?normalizeTemporalInterval(coverage->validFrom,interval.validTo):interval;
    }
    if(coverage) {
        const Validity value{coverage->validFrom,coverage->validTo};
        if(validityContainsAtEnd(value,point))return value;
    }
    throw TimelineError("TIMELINE_INACTIVE","No map coverage for "+id.domain+":"+id.id+" at "+month);
}
ResolvedWorld PreparedTimelineWorld::resolve(const std::string& month,const ResolvedWorld* previous) const {
    const auto cursor=parseTemporal(month);
    const auto point=cursor.precision=="month"?temporalMonthEnd(cursor.canonical):cursor;
    const TemporalKey atEnd=point.endKey;
    const auto& index=*data_;
    std::set<ObjectRef> changed;
    if(previous){
        const auto old=parseTemporal(previous->month);
        const auto oldEnd=(old.precision=="month"?temporalMonthEnd(old.canonical):old).endKey;
        const auto& low=std::min(oldEnd,atEnd);
        const auto& high=std::max(oldEnd,atEnd);
        for(auto event=index.events.upper_bound(low);event!=index.events.end()&&!(high<event->first);++event)
            changed.insert(event->second.begin(),event->second.end());
        if(changed.empty()){
            auto result=*previous;result.month=cursor.canonical;return result;
        }
        // A broad jump should not copy the old property map or compare
        // every prior row when most identities require reconstruction.
        if(changed.size()>index.entities.size()/2){previous=nullptr;changed.clear();}
    }
    ResolvedWorld result;result.month=cursor.canonical;
    result.projectionIdentity=std::make_shared<const bool>(true);
    result.entities.reserve(index.entities.size());
    const auto propertiesFor=[&](const ObjectRef& ref,const auto& properties){
        for(const auto& [name,entries]:properties)
            if(const auto* property=selectedInterval(entries,atEnd))
                result.activeProperties[ref][name]=property->value;
    };
    if(previous){
        result.activeProperties=previous->activeProperties;
        for(const auto& ref:changed){
            result.activeProperties.erase(ref);
            const auto found=index.properties.find(ref);
            if(found!=index.properties.end())propertiesFor(ref,found->second);
        }
    }else for(const auto& [ref,properties]:index.properties)propertiesFor(ref,properties);

    // Keep canonical catalog order. Unchanged identities reuse their already
    // resolved lifetime, geometry, direct parent and property projection.
    for(const auto& identity:index.entities) {
        const auto& ref=identity.objectRef;
        if(previous&&!changed.count(ref)){
            const auto* row=previous->find(ref);
            if(row){
                result.offsets.emplace(ref,result.entities.size());
                result.entities.push_back(*row);
            }
            continue;
        }
        const auto* lifetime=selected(index.lifetimes,ref,atEnd);
        if(!lifetime)continue;
        const auto* geometry=selected(index.geometries,ref,atEnd);
        if(!geometry)continue;
        const auto* parent=selected(index.parents,ref,atEnd);
        result.entities.push_back({ref,geometry->geometryRef,geometry->rendering,parent?parent->parentId:"",parent?parent->coverageMode:"explicit"});
        auto& entity=result.entities.back();
        entity.validity=lifetime->validity;
        result.offsets.emplace(ref,result.entities.size()-1);
        const auto found=result.activeProperties.find(ref);
        if(found!=result.activeProperties.end())entity.properties=found->second;
    }
    std::set<GeometryRef> required;
    for(const auto& row:result.entities)required.insert(row.geometryRef);
    result.requiredGeometries.assign(required.begin(),required.end());
    for(auto& entity:result.entities) {
        // Any ancestor's changed direct relation can affect this row's root,
        // even when the row itself has no event. Otherwise retain its chain.
        if(previous&&!changed.count(entity.objectRef)
            &&std::none_of(entity.ancestors.begin(),entity.ancestors.end(),[&](const auto& id){
                return changed.count(ObjectRef{"territorial",id})!=0;
            }))continue;
        entity.ancestors.clear();
        auto parent=entity.parentId;
        while(!parent.empty()) {
            entity.ancestors.push_back(parent);
            const auto* resolvedParent=result.find(ObjectRef{"territorial",parent});
            if(!resolvedParent)throw TimelineError("TIMELINE_PARENT_INACTIVE","Inactive parent "+parent);
            parent=resolvedParent->parentId;
        }
        entity.rootId=entity.ancestors.empty()?entity.objectRef.id:entity.ancestors.back();
    }
    return result;
}
ResolvedWorld resolveWorld(const TimelineRecords& records,const TimelineValidationContext& context,
                           const std::string& month) {
    // Preserve date-input precedence before validating independent records.
    const auto cursor=parseTemporal(month);
    return PreparedTimelineWorld(records,context).resolve(cursor.canonical);
}
}
