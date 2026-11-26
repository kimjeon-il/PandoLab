#include <pandoeditor/gisexchange.h>
#include <pandoeditor/project.h>
#include <pandoeditor/geometrypredicates.h>
#include <algorithm>
#include <cctype>
#include <cmath>
#include <limits>
#include <set>
#include <stdexcept>

namespace pandoeditor {
GisCountryMergeIdentities planGisCountryMerge(const std::vector<std::u16string>& current,
    const std::vector<std::u16string>& incoming) {
    GisCountryMergeIdentities result;
    if (incoming.empty()) {result.status = GisCountryMergeStatus::Empty; return result;}
    std::set<std::u16string> imported;
    for (const auto& id:incoming)if (id.empty()||!imported.insert(id).second) {
        result.status = GisCountryMergeStatus::InvalidIds; return result;
    }
    std::map<std::u16string, int> lookup;
    for (std::size_t i = 0; i<current.size(); ++i)lookup[current[i]] = int(i);
    for (const auto& id:incoming) {const auto found = lookup.find(id);
        if (found==lookup.end())result.existing.push_back(-1);
        else {result.existing.push_back(found->second); ++result.matched;}}
    for (std::size_t i = 0; i<current.size(); ++i)if (!imported.count(current[i]))result.unaffected.push_back(i);
    return result;
}
GisCountryMergeGeometry planGisCountryGeometry(std::size_t incomingCount,
    const std::vector<std::size_t>& unaffected, bool replaceById, const GisCountryMergeOperations& operations) {
    GisCountryMergeGeometry result;
    if (!replaceById)operations.prepare();
    const auto visit = [&](int incoming, std::size_t country) {
        if (!operations.bounds(incoming, country))return;
        const auto planar = operations.intersection(incoming, country);
        if (!planar||*planar<=1e-8)return;
        result.overlapAreaKm2+=operations.area();
        if (!replaceById)result.donors.push_back({country, !operations.subtract(country)});
    };
    if (replaceById) {for (std::size_t i = 0; i<incomingCount; ++i)for (const auto country:unaffected)visit(int(i), country);}
    else for (const auto country:unaffected)visit(-1, country);
    return result;
}
bool gisCountryMergeCanCommit(double overlapAreaKm2) noexcept { return overlapAreaKm2<=0.001; }
}
