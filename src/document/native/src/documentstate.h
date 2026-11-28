#pragma once
#include <pandoeditor/document.h>
#include <pandoeditor/objectproperties.h>
#include <utility>
#include <set>
#include <algorithm>

namespace pandoeditor::detail {
// Construct at its final heap address. Views borrow this document, never a
// separate/movable candidate. A shared const state is the snapshot boundary.
struct DocumentState {
    ProjectDocument document;
    DocumentIndex index;
    const bool staticTimeline = true;
    std::map<ObjectRef, ObjectPropertyView> properties;
    std::vector<CountryView> countries;
    std::map<std::string, std::size_t> countryIndex;
    std::set<ObjectRef> inactiveIds;

    DocumentState() = default; // unloaded Project only
    explicit DocumentState(ProjectDocument candidate, std::set<ObjectRef> inactive = {}, bool referenceOnlyGeometry = false)
        : document(std::move(candidate)), index(validateDocument(document)), staticTimeline(isStaticTimeline(document)), inactiveIds(std::move(inactive))
    { initializeViews(referenceOnlyGeometry); }
    struct VerifiedResources {};
    // Only Project's verified geometry-resource admission/eviction may use
    // this path. Identities, bindings, declarations and content are unchanged.
    DocumentState(ProjectDocument candidate, const DocumentState& previous, VerifiedResources, bool referenceOnlyGeometry = false)
        :document(std::move(candidate)), index(previous.index), staticTimeline(previous.staticTimeline), inactiveIds(previous.inactiveIds)
    { initializeViews(referenceOnlyGeometry); }
    void initializeViews(bool referenceOnlyGeometry) {
        if (!staticTimeline)return;
        properties = objectPropertyViews(document);
        // The read-only Viewer uses verified globe meshes and object references.
        // Native coordinate consumers retain the complete strict country view.
        if (referenceOnlyGeometry&&!document.geometries.resources().empty())return;
        auto allCountries = countryViews(document, inactiveIds);
        countries.reserve(allCountries.size());
        for (const auto& view:allCountries)if (!inactiveIds.count(territorialRef(view.id)))countries.push_back(view);
        for (std::size_t i = 0; i < countries.size(); ++i)
            countryIndex.emplace(countries[i].id, i);
    }
    DocumentState(const DocumentState&) = delete;
    DocumentState& operator = (const DocumentState&) = delete;
    DocumentState(DocumentState&&) = delete;
    DocumentState& operator = (DocumentState&&) = delete;
};
} // namespace pandoeditor::detail
