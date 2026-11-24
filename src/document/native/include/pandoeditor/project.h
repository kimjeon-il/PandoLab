#pragma once
#include <pandoeditor/commands.h>
#include <pandoeditor/objectproperties.h>
#include <pandoeditor/timeline-resolver.h>
#include <string>
#include <memory>
#include <vector>
#include <utility>
#include <set>
#include <array>

namespace pandoeditor {

class Project;
class ProjectReplacementState {
    friend class Project;
    struct Data;
    std::shared_ptr<const Data> data_;
};
class ProjectSnapshot {
public:
    const std::string& instanceId() const { return instanceId_; }
    std::uint64_t revision() const { return revision_; }
    const std::string& timelineMonth() const noexcept { return timelineMonth_; }
    bool timelineEditsEnabled() const noexcept { return timelineEditsEnabled_; }
    const std::set<ObjectRef>& inactiveObjectRefs() const noexcept;
    const ProjectDocument& document() const noexcept;
    const DocumentIndex& index() const noexcept;
    const CountryView* country(const std::string&) const;
    bool matches(const Project&) const noexcept;
private:
    friend class Project;
    ProjectSnapshot(std::shared_ptr<const detail::DocumentState> state, std::string instanceId, std::uint64_t revision,
                    std::string timelineMonth={},bool timelineEditsEnabled=false)
        : state_(std::move(state)), instanceId_(std::move(instanceId)), revision_(revision), timelineMonth_(std::move(timelineMonth)),timelineEditsEnabled_(timelineEditsEnabled) {}
    std::shared_ptr<const detail::DocumentState> state_;
    std::string instanceId_;
    std::uint64_t revision_;
    std::string timelineMonth_;
    bool timelineEditsEnabled_=false;
};

class Project {
public:
    const std::string& timelineCursor() const noexcept { return timelineCursor_; }
    // Session month only: no content revision, dirty bit or history entry.
    bool setTimelineCursor(const std::string& month,bool activateEdits=true,const ResolvedWorld* resolved=nullptr,
        std::vector<GeometryRef>* evictedResources=nullptr);
    bool timelineEditsEnabled() const noexcept { return timelineEditsEnabled_; }
    ResolvedWorld resolveWorld(const std::string& month) const;
    // A borrowed, immutable result remains valid across later cache lookups.
    std::shared_ptr<const ResolvedWorld> resolveWorldShared(const std::string& month) const;
    std::vector<GeometryRef> missingGeometries(const std::string& month={}) const;
    std::uint64_t presentationRevision() const noexcept { return presentationRevision_; }
    Project();
    ProjectSnapshot snapshot() const { return {state_,instanceId_,revision_,timelineCursor_,timelineEditsEnabled_}; }
    ProjectSnapshot snapshotForView() const;
    const std::string& instanceId() const { return instanceId_; }
    std::uint64_t revision() const { return revision_; }
    Project(const Project&) = delete;
    Project& operator=(const Project&) = delete;
    Project(Project&&) noexcept = default;
    Project& operator=(Project&&) noexcept = default;
    static std::string normalizeName(const std::string& name);
    static void validate(const ProjectDocument& document);
    void replace(ProjectDocument document);
    const ProjectDocument& document() const noexcept;
    const ProjectDocument& viewDocument() const noexcept;
    const std::set<ObjectRef>& inactiveObjectRefs() const noexcept;
    const std::vector<CountryView>& countries() const noexcept;
    const DocumentIndex& index() const noexcept;
    const DocumentIndex& viewIndex() const noexcept;
    bool hasActiveObject(const ObjectRef&) const noexcept;
    const CountryView* country(const std::string& id) const;
    const ObjectPropertyView* propertyView(const ObjectRef&) const;
    ProjectReplacementState captureReplacement() const;
    void restoreReplacement(const ProjectReplacementState&);
private:
    friend class DocumentSession;
    void admitTerritorialSource(ProjectDocument,const std::string& month,bool activateEdits);
    void admitPresentation(ProjectDocument,bool advanceRevision=true);
    void admitGeometryResources(GeometryStore);
    std::set<GeometryRef> protectedGeometryResources(const ResolvedWorld* current,const ResolvedWorld* target=nullptr) const;
    std::shared_ptr<const ResolvedWorld> resolveTimelineMetadata(const std::string&) const;
    void admitTerritorialDirtyIds(const std::function<std::vector<std::string>(const ProjectDocument&)>&);
    // Capture snapshots and mutate Project only on the owner thread.
    // Workers may prepare against ProjectSnapshot, never against live Project.
    std::shared_ptr<const detail::DocumentState> state_, viewState_;
    // Rebuilt only when the authoritative document snapshot changes, never
    // for a cursor-only transition. The source pin prevents address reuse.
    mutable std::weak_ptr<const detail::DocumentState> preparedTimelineSource_;
    mutable std::shared_ptr<const PreparedTimelineWorld> preparedTimeline_;
    // The displayed month and recent target months share immutable results.
    // Keep the displayed month when speculative preparation fills the cache.
    mutable std::array<std::shared_ptr<const ResolvedWorld>,4> resolvedTimeline_{};
    std::string instanceId_;
    std::uint64_t revision_ = 0;
    std::uint64_t presentationRevision_ = 0;
    std::string timelineCursor_;
    bool timelineEditsEnabled_=false;
};
} // namespace pandoeditor
