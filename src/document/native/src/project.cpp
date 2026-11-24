#include <pandoeditor/project.h>
#include <pandoeditor/projectcodec.h>
#include "documentstate.h"
#include <pandoeditor/timeline-view.h>
#include <pandoeditor/losslessjson.h>
#include <algorithm>
#include <atomic>
#include <cctype>
#include <limits>
#include <stdexcept>
#include <type_traits>

namespace pandoeditor {
namespace {
std::string nextInstanceId()
{
    // Process-local session identity, deliberately not persisted in a document.
    static std::atomic<std::uint64_t> counter{0};
    auto value = counter.load(std::memory_order_relaxed);
    do {
        if (value == std::numeric_limits<std::uint64_t>::max())
            throw std::overflow_error("PROJECT_INSTANCE_OVERFLOW");
    } while (!counter.compare_exchange_weak(value, value + 1, std::memory_order_relaxed));
    return "project-session-" + std::to_string(value + 1);
}
bool sameTimelineRecords(const TimelineRecords& a,const TimelineRecords& b) {
    const auto validity=[](const Validity& x,const Validity& y){return x.from==y.from&&x.to==y.to;};
    const auto rows=[](const auto& x,const auto& y,const auto& equal){
        return x.size()==y.size()&&std::equal(x.begin(),x.end(),y.begin(),equal);
    };
    return a.schemaVersion==b.schemaVersion
        &&rows(a.lifetimes,b.lifetimes,[&](const auto& x,const auto& y){
            return x.id==y.id&&x.objectRef==y.objectRef&&validity(x.validity,y.validity);})
        &&rows(a.geometryBindings,b.geometryBindings,[&](const auto& x,const auto& y){
            return x.id==y.id&&x.objectRef==y.objectRef&&validity(x.validity,y.validity)
                &&x.geometryRef==y.geometryRef&&x.rendering==y.rendering;})
        &&rows(a.parentRelations,b.parentRelations,[&](const auto& x,const auto& y){
            return x.id==y.id&&x.objectRef==y.objectRef&&validity(x.validity,y.validity)
                &&x.parentId==y.parentId&&x.coverageMode==y.coverageMode;})
        &&rows(a.propertyBindings,b.propertyBindings,[&](const auto& x,const auto& y){
            return x.id==y.id&&x.objectRef==y.objectRef&&validity(x.validity,y.validity)
                &&x.property==y.property&&x.value==y.value;});
}
bool sameTimelineCatalog(const ProjectDocument& a,const ProjectDocument& b) {
    const auto x=timelineEntityCatalog(a),y=timelineEntityCatalog(b);
    return x.size()==y.size()&&std::equal(x.begin(),x.end(),y.begin(),[](const auto& left,const auto& right){
        return left.objectRef==right.objectRef&&left.entityKind==right.entityKind;
    });
}
std::shared_ptr<const detail::DocumentState> projectedState(const ProjectDocument& document,
                                                             const std::string& month,const ResolvedWorld* resolved=nullptr) {
    if(isStaticTimeline(document))return {};
    if(month.empty())throw TimelineError("TIMELINE_CURSOR_REQUIRED","dated view needs a month");
    if(resolved&&resolved->month!=month)
        throw TimelineError("STALE_REVISION","Resolved timeline month differs from requested projection");
    if(resolved){
        auto projection=projectResolvedTimeline(document,*resolved);
        return std::make_shared<const detail::DocumentState>(std::move(projection.document),std::move(projection.inactiveIds));
    }
    auto projection=timelineDocumentView(document,month);
    return std::make_shared<const detail::DocumentState>(std::move(projection.document),std::move(projection.inactiveIds));
}
}
struct ProjectReplacementState::Data {
    std::shared_ptr<const detail::DocumentState> state,view;
    std::string instanceId,month;
    std::uint64_t revision,presentationRevision;
    bool timelineEditsEnabled;
};
ProjectReplacementState Project::captureReplacement() const {
    ProjectReplacementState result;result.data_=std::make_shared<const ProjectReplacementState::Data>(ProjectReplacementState::Data{
        state_,viewState_,instanceId_,timelineCursor_,revision_,presentationRevision_,timelineEditsEnabled_});return result;
}
void Project::restoreReplacement(const ProjectReplacementState& checkpoint) {
    if(!checkpoint.data_)throw std::invalid_argument("CORE_REPLACEMENT_ABSENT");const auto& data=*checkpoint.data_;
    auto instance=data.instanceId,month=data.month;
    state_=data.state;viewState_=data.view;instanceId_.swap(instance);timelineCursor_.swap(month);
    revision_=data.revision;presentationRevision_=data.presentationRevision;
    timelineEditsEnabled_=data.timelineEditsEnabled;
}
void Project::admitTerritorialSource(ProjectDocument document,const std::string& month,bool activateEdits) {
    if(revision_==std::numeric_limits<std::uint64_t>::max()||presentationRevision_==std::numeric_limits<std::uint64_t>::max())throw std::overflow_error("PROJECT_REVISION_OVERFLOW");
    auto current=std::make_shared<const detail::DocumentState>(std::move(document));
    auto view=projectedState(current->document,month);auto cursor=month;
    state_=std::move(current);viewState_=std::move(view);timelineCursor_.swap(cursor);
    timelineEditsEnabled_=activateEdits;++revision_;++presentationRevision_;
}
void Project::admitPresentation(ProjectDocument document,bool advanceRevision) {
    if(advanceRevision&&presentationRevision_==std::numeric_limits<std::uint64_t>::max())throw std::overflow_error("PROJECT_REVISION_OVERFLOW");
    auto next=std::make_shared<const detail::DocumentState>(std::move(document));
    const bool reuse=preparedTimeline_&&preparedTimelineSource_.lock()==state_
        &&sameTimelineRecords(state_->document.timelineRecords,next->document.timelineRecords)
        &&sameTimelineCatalog(state_->document,next->document);
    std::shared_ptr<const ResolvedWorld> resolved;
    if(reuse&&!timelineCursor_.empty()&&!isStaticTimeline(next->document))
        resolved=resolveTimelineMetadata(timelineCursor_);
    auto view=projectedState(next->document,timelineCursor_,resolved.get());
    state_=std::move(next);viewState_=std::move(view);
    if(reuse)preparedTimelineSource_=state_;
    if(advanceRevision)++presentationRevision_;
}
void Project::admitTerritorialDirtyIds(const std::function<std::vector<std::string>(const ProjectDocument&)>& read) {
    std::map<const detail::DocumentState*,std::shared_ptr<const detail::DocumentState>> rebuilt;
    const auto rebase=[&](const std::shared_ptr<const detail::DocumentState>& old) {
        if(const auto found=rebuilt.find(old.get());found!=rebuilt.end())return found->second;
        auto ids=read(old->document);auto result=old;
        if(ids!=old->document.dirtyTerritorialIds) {auto document=old->document;document.dirtyTerritorialIds=std::move(ids);result=std::make_shared<const detail::DocumentState>(std::move(document));}
        rebuilt.emplace(old.get(),result);return result;
    };
    auto state=rebase(state_);
    // This path changes only the dirty-territory marker list. Both timeline
    // records and entity catalog remain unchanged, even when state_ is copied.
    const bool reuse=preparedTimeline_&&preparedTimelineSource_.lock()==state_;
    std::shared_ptr<const ResolvedWorld> resolved;
    if(reuse&&!timelineCursor_.empty()&&!isStaticTimeline(state->document))
        resolved=resolveTimelineMetadata(timelineCursor_);
    auto view=projectedState(state->document,timelineCursor_,resolved.get());
    state_=std::move(state);viewState_=std::move(view);
    if(reuse)preparedTimelineSource_=state_;
}
Project::Project() : state_(std::make_shared<const detail::DocumentState>()), instanceId_(nextInstanceId()) {}
std::string Project::normalizeName(const std::string& name)
{
    auto first=std::find_if_not(name.begin(),name.end(),[](unsigned char c){return std::isspace(c);});
    auto last=std::find_if_not(name.rbegin(),name.rend(),[](unsigned char c){return std::isspace(c);}).base();
    return first<last ? std::string(first,last) : std::string();
}
void Project::validate(const ProjectDocument& document) { (void)validateDocument(document); }
void Project::replace(ProjectDocument document)
{
    auto next=std::make_shared<const detail::DocumentState>(std::move(document));
    auto identity=nextInstanceId();
    // No allocation or validation after this point: replace is all-or-nothing.
    state_=std::move(next); viewState_.reset(); instanceId_.swap(identity);
    revision_=0; presentationRevision_=0;
    timelineCursor_.clear();timelineEditsEnabled_=!isStaticTimeline(state_->document);
}
bool Project::setTimelineCursor(const std::string& month,bool activateEdits,const ResolvedWorld* resolved) {
    const auto header=codecjson::parse(document().exchangeMetadata);if(header.object.count("projectSetup"))projectcodec::requireNavigationMonth(header.object.at("projectSetup"),month);
    std::string next;
    if(!month.empty()) {
        const auto parsed=parseTemporal(month);
        if(parsed.precision!="month")throw std::invalid_argument("INVALID_TIMELINE_CURSOR: month precision required");
        next=parsed.canonical;
    }
    const bool activates=activateEdits&&!timelineEditsEnabled_;
    if(next==timelineCursor_){timelineEditsEnabled_=timelineEditsEnabled_||activateEdits;return activates;}
    const auto cached=(!resolved&&!next.empty()&&!isStaticTimeline(document()))?resolveTimelineMetadata(next):nullptr;
    auto view=next.empty()?std::shared_ptr<const detail::DocumentState>{}:projectedState(document(),next,resolved?resolved:cached.get());
    viewState_=std::move(view);
    timelineCursor_.swap(next);timelineEditsEnabled_=timelineEditsEnabled_||activateEdits;return true;
}
ProjectSnapshot Project::snapshotForView() const {
    if(!isStaticTimeline(document())) {
        if(!viewState_)throw TimelineError("TIMELINE_CURSOR_REQUIRED","month required for dated view");
        return {viewState_,instanceId_,revision_,timelineCursor_,timelineEditsEnabled_};
    }
    return snapshot();
}
std::shared_ptr<const ResolvedWorld> Project::resolveTimelineMetadata(const std::string& month) const {
    const auto& d=document();
    const bool reuse=preparedTimelineSource_.lock()==state_&&preparedTimeline_;
    if(reuse)for(std::size_t i=0;i<resolvedTimeline_.size();++i) {
        if(resolvedTimeline_[i]&&resolvedTimeline_[i]->month==month) {
            auto found=resolvedTimeline_[i];
            for(;i>0;--i)resolvedTimeline_[i]=std::move(resolvedTimeline_[i-1]);
            resolvedTimeline_[0]=found;
            return found;
        }
    }
    const auto requested=parseTemporal(month);
    if(requested.precision!="month"||requested.canonical!=month)
        throw TimelineError("PL-TEMPORAL-001","World queries require a canonical month.");
    if(!reuse) {
        preparedTimeline_=std::make_shared<const PreparedTimelineWorld>(d.timelineRecords,
            TimelineValidationContext{timelineEntityCatalog(d),
                [&](const ObjectRef&,const GeometryRef& ref){return d.geometries.contains(ref);}});
        preparedTimelineSource_=state_;
        resolvedTimeline_={};
    }
    auto resolved=std::make_shared<const ResolvedWorld>(preparedTimeline_->resolve(month));
    std::size_t slot=resolvedTimeline_.size()-1;
    while(slot>0&&resolvedTimeline_[slot]&&resolvedTimeline_[slot]->month==timelineCursor_)--slot;
    for(;slot>0;--slot)resolvedTimeline_[slot]=std::move(resolvedTimeline_[slot-1]);
    resolvedTimeline_[0]=resolved;
    return resolved;
}
std::shared_ptr<const ResolvedWorld> Project::resolveWorldShared(const std::string& month) const {
    const auto world=resolveTimelineMetadata(month);
    document().geometries.requireReady(world->requiredGeometries());
    return world;
}
ResolvedWorld Project::resolveWorld(const std::string& month) const {
    return *resolveWorldShared(month);
}
std::vector<GeometryRef> Project::missingGeometries(const std::string& month) const {
    std::vector<GeometryRef> required;
    if(month.empty())for(const auto& [ref,resource]:document().geometries.resources())required.push_back(ref);
    else required=resolveTimelineMetadata(month)->requiredGeometries();
    std::vector<GeometryRef> missing;for(const auto& ref:required)if(!document().geometries.get(ref))missing.push_back(ref);
    return missing;
}
void Project::admitGeometryResources(const GeometryStore& resources) {
    std::map<const detail::DocumentState*,std::shared_ptr<const detail::DocumentState>> rebuilt;
    const auto rebase=[&](const std::shared_ptr<const detail::DocumentState>& old) {
        if(const auto found=rebuilt.find(old.get());found!=rebuilt.end())return found->second;
        auto document=old->document;const bool changed=document.geometries.retainReadyFrom(resources);
        auto next=changed?std::make_shared<const detail::DocumentState>(std::move(document)):old;
        rebuilt.emplace(old.get(),next);return next;
    };
    auto state=rebase(state_);
    const bool reuse=preparedTimeline_&&preparedTimelineSource_.lock()==state_;
    std::shared_ptr<const ResolvedWorld> resolved;if(reuse&&!timelineCursor_.empty()&&!isStaticTimeline(state->document))resolved=resolveTimelineMetadata(timelineCursor_);
    auto view=projectedState(state->document,timelineCursor_,resolved.get());
    state_=std::move(state);viewState_=std::move(view);
    if(reuse)preparedTimelineSource_=state_;
}
const ProjectDocument& Project::document() const noexcept { return state_->document; }
const ProjectDocument& Project::viewDocument() const noexcept {
    return viewState_?viewState_->document:state_->document;
}
const std::set<ObjectRef>& Project::inactiveObjectRefs() const noexcept {
    return viewState_?viewState_->inactiveIds:state_->inactiveIds;
}
const std::vector<CountryView>& Project::countries() const noexcept {
    return viewState_?viewState_->countries:state_->countries;
}
const DocumentIndex& Project::index() const noexcept { return state_->index; }
const DocumentIndex& Project::viewIndex() const noexcept {
    return viewState_?viewState_->index:state_->index;
}
const CountryView* Project::country(const std::string& id) const
{
    const auto& state=viewState_?viewState_:state_;
    auto it=state->countryIndex.find(id);
    return it==state->countryIndex.end()?nullptr:&countries()[it->second];
}
const ObjectPropertyView* Project::propertyView(const ObjectRef& ref) const {
    const auto& state=viewState_?viewState_:state_;
    auto it=state->properties.find(ref);return it==state->properties.end()?nullptr:&it->second;
}
bool Project::hasActiveObject(const ObjectRef& ref) const noexcept {
    return index().objects.count(ref)!=0&&!inactiveObjectRefs().count(ref);
}
} // namespace pandoeditor
