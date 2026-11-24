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
    std::map<ObjectRef,std::size_t> catalogOrder;
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
    for(std::size_t i=0;i<next->entities.size();++i)next->catalogOrder.emplace(next->entities[i].objectRef,i);
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
    const auto found=offsets().find(id);
    return found==offsets().end()?nullptr:&entities()[found->second];
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
            return {cursor.canonical,previous->projection};
        }
        // A broad jump should not copy the old property map or compare
        // every prior row when most identities require reconstruction.
        if(changed.size()>index.entities.size()/2){previous=nullptr;changed.clear();}
    }
    auto projection=std::make_shared<ResolvedWorldProjection>();
    ResolvedWorld result{cursor.canonical,projection};
    if(previous){
        projection->deltaBase=previous->projection;
        projection->offsets=previous->projection->offsets;
        projection->activeProperties=previous->projection->activeProperties;
        projection->geometryUsers=previous->projection->geometryUsers;
        projection->children=previous->projection->children;
        projection->requiredGeometries=previous->projection->requiredGeometries;
    }
    // Copy an index only when one of its keys actually changes. Property
    // payloads stay immutable, and property-only dates retain the geometry
    // and hierarchy indexes by identity.
    std::shared_ptr<ResolvedPropertyIndex> properties;
    const auto updateProperties=[&](const ObjectRef& ref){
        ResolvedProperties values;
        const auto found=index.properties.find(ref);
        if(found!=index.properties.end())for(const auto& [name,entries]:found->second)
            if(const auto* property=selectedInterval(entries,atEnd))values.emplace(name,property->value);
        const auto& current=*projection->activeProperties;
        const auto old=current.find(ref);
        if(old==current.end()?values.empty():*old->second==values)return;
        if(!properties){properties=std::make_shared<ResolvedPropertyIndex>(current);projection->activeProperties=properties;}
        if(values.empty())properties->erase(ref);
        else (*properties)[ref]=std::make_shared<const ResolvedProperties>(std::move(values));
    };
    if(previous){for(const auto& ref:changed)updateProperties(ref);}
    else for(const auto& [ref,entries]:index.properties)updateProperties(ref);
    const auto makeRow=[&](const ObjectRef& ref)->std::shared_ptr<ResolvedEntity>{
        const auto* lifetime=selected(index.lifetimes,ref,atEnd);
        const auto* geometry=selected(index.geometries,ref,atEnd);
        if(!lifetime||!geometry)return {};
        const auto* parent=selected(index.parents,ref,atEnd);
        auto row=std::make_shared<ResolvedEntity>(ResolvedEntity{ref,geometry->geometryRef,geometry->rendering,
            parent?parent->parentId:"",parent?parent->coverageMode:"explicit"});
        row->validity=lifetime->validity;
        const auto found=result.activeProperties().find(ref);
        if(found!=result.activeProperties().end())row->properties=*found->second;
        return row;
    };
    std::map<ObjectRef,std::shared_ptr<ResolvedEntity>> fresh;
    std::set<ObjectRef> affected=changed;
    std::shared_ptr<ResolvedGeometryUsers> geometryUsers;
    std::shared_ptr<ResolvedChildren> children;
    bool requiredChanged=!previous,membershipChanged=!previous;
    const auto updateResources=[&](const ObjectRef& ref,const ResolvedEntity* before,const ResolvedEntity* after){
        if((before!=nullptr)!=(after!=nullptr))membershipChanged=true;
        if(!before||!after||!(before->geometryRef==after->geometryRef)){
            if(before||after){
                if(!geometryUsers){geometryUsers=std::make_shared<ResolvedGeometryUsers>(*projection->geometryUsers);projection->geometryUsers=geometryUsers;}
                if(before){
                    auto it=geometryUsers->find(before->geometryRef);
                    if(it==geometryUsers->end())throw TimelineError("TIMELINE_GEOMETRY","Missing prior geometry reference count.");
                    if(--it->second==0){geometryUsers->erase(it);requiredChanged=true;}
                }
                if(after){
                    auto [it,inserted]=geometryUsers->emplace(after->geometryRef,0);
                    ++it->second;requiredChanged=requiredChanged||inserted;
                }
            }
        }
        const auto oldParent=before?before->parentId:std::string{};
        const auto newParent=after?after->parentId:std::string{};
        if(oldParent!=newParent){
            if(!children){children=std::make_shared<ResolvedChildren>(*projection->children);projection->children=children;}
            if(!oldParent.empty()){
                auto it=children->find(oldParent);
                if(it!=children->end()){it->second.erase(ref);if(it->second.empty())children->erase(it);}
            }
            if(!newParent.empty())(*children)[newParent].insert(ref);
        }
    };
    if(previous){
        // Resolve only event owners. Discover descendants using the previous
        // direct-child graph; no full ancestry scan across the active world.
        std::vector<ObjectRef> descendants;
        for(const auto& ref:changed){
            const auto* before=previous->find(ref);
            auto after=makeRow(ref);
            if(ref.domain=="territorial"&&
                ((before!=nullptr)!=(after!=nullptr)||(before&&after&&before->parentId!=after->parentId)))
                descendants.push_back(ref);
            updateResources(ref,before,after.get());
            fresh.emplace(ref,std::move(after));
        }
        std::set<ObjectRef> visited;
        for(std::size_t i=0;i<descendants.size();++i){
            const auto ref=descendants[i];
            if(ref.domain!="territorial"||!visited.insert(ref).second)continue;
            const auto found=previous->projection->children->find(ref.id);
            if(found==previous->projection->children->end())continue;
            for(const auto& child:found->second){affected.insert(child);descendants.push_back(child);}
        }
        if(!membershipChanged){
            // The ordered vector is a shallow copy of shared row handles;
            // its offsets and resource indexes need not be rebuilt.
            projection->entities=previous->projection->entities;
            for(const auto& [ref,row]:fresh)if(row)projection->entities[previous->offsets().at(ref)]=row;
        }else{
            // Merge only the previously active rows and newly active owners
            // in canonical catalog order, not every historical identity.
            std::vector<std::pair<std::size_t,std::shared_ptr<const ResolvedEntity>>> added;
            for(const auto& [ref,row]:fresh)if(row&&!previous->find(ref))added.emplace_back(index.catalogOrder.at(ref),row);
            std::sort(added.begin(),added.end(),[](const auto& a,const auto& b){return a.first<b.first;});
            auto offsets=std::make_shared<ResolvedOffsets>();
            projection->entities.reserve(previous->entities().size()+added.size());
            const auto append=[&](const auto& row){offsets->emplace(row->objectRef,projection->entities.size());projection->entities.push_back(row);};
            std::size_t cursor=0;
            for(const auto& row:previous->projection->entities){
                const auto rank=index.catalogOrder.at(row->objectRef);
                while(cursor<added.size()&&added[cursor].first<rank)append(added[cursor++].second);
                const auto found=fresh.find(row->objectRef);
                if(found==fresh.end())append(row);
                else if(found->second)append(found->second);
            }
            while(cursor<added.size())append(added[cursor++].second);
            projection->offsets=std::move(offsets);
        }
    }else{
        auto offsets=std::make_shared<ResolvedOffsets>();
        projection->entities.reserve(index.entities.size());
        for(const auto& identity:index.entities){
            const auto& ref=identity.objectRef;
            auto row=makeRow(ref);
            if(!row)continue;
            updateResources(ref,nullptr,row.get());
            offsets->emplace(ref,projection->entities.size());
            projection->entities.push_back(row);fresh.emplace(ref,std::move(row));affected.insert(ref);
        }
        projection->offsets=std::move(offsets);
    }
    if(requiredChanged){
        auto required=std::make_shared<std::vector<GeometryRef>>();required->reserve(projection->geometryUsers->size());
        for(const auto& [ref,count]:*projection->geometryUsers)required->push_back(ref);
        projection->requiredGeometries=std::move(required);
    }
    // All direct rows and offsets are now installed. Compute ancestry only
    // for the affected subgraph; other entity allocations are shared.
    for(const auto& ref:affected){
        const auto offset=result.offsets().find(ref);
        if(offset==result.offsets().end())continue;
        auto& slot=projection->entities[offset->second];
        const auto found=fresh.find(ref);
        auto entity=found!=fresh.end()&&found->second?found->second:std::make_shared<ResolvedEntity>(*slot);
        entity->ancestors.clear();
        auto parent=entity->parentId;
        while(!parent.empty()){
            entity->ancestors.push_back(parent);
            const auto* resolvedParent=result.find(ObjectRef{"territorial",parent});
            if(!resolvedParent)throw TimelineError("TIMELINE_PARENT_INACTIVE","Inactive parent "+parent);
            parent=resolvedParent->parentId;
        }
        entity->rootId=entity->ancestors.empty()?entity->objectRef.id:entity->ancestors.back();
        slot=std::move(entity);
    }
    if(previous)projection->affected.assign(affected.begin(),affected.end());
    return result;
}
ResolvedWorld resolveWorld(const TimelineRecords& records,const TimelineValidationContext& context,
                           const std::string& month) {
    // Preserve date-input precedence before validating independent records.
    const auto cursor=parseTemporal(month);
    return PreparedTimelineWorld(records,context).resolve(cursor.canonical);
}
}
