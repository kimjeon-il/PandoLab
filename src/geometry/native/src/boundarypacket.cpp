#include <pandoeditor/boundarypacket.h>
#include <cmath>
#include <map>
#include <stdexcept>
#include <string>

namespace pandoeditor {
namespace {
struct Group {
    std::string key;
    std::vector<BoundaryEdge> edges;
};
std::string ownerKey(const std::vector<std::string>& ids) {
    std::string key;
    for (const auto& id:ids) {
        if (!key.empty())key+='|';
        key+=id;
    }
    return key;
}
std::vector<Group> collect(const std::vector<SharedStrokeSource>& sources) {
    std::vector<Group> groups;
    std::map<std::string, std::size_t> positions;
    for (const auto& source:sources) {
        if (source.ownerIds.size()<2)
            throw std::invalid_argument("INVALID_SHARED_STROKE: missing source owners");
        if (!std::isfinite(source.edge.first.x)||!std::isfinite(source.edge.first.y)
            ||!std::isfinite(source.edge.second.x)||!std::isfinite(source.edge.second.y))
            throw std::invalid_argument("INVALID_SHARED_STROKE: nonfinite point");
        const auto key = ownerKey(source.ownerIds);
        auto it = positions.find(key);
        if (it==positions.end()) {
            const auto index = groups.size();
            positions.emplace(key, index);
            groups.push_back({key, {}});
            it = positions.find(key);
        }
        groups[it->second].edges.push_back(source.edge);
    }
    return groups;
}
}
std::size_t verifySharedStrokeChains(const std::vector<SharedStrokeSource>& sources) {
    std::size_t checked = 0;
    for (const auto& group:collect(sources)) {
        std::size_t observed = 0;
        for (const auto& chain:connectBoundaryChains(group.edges))
            if (chain.size()>=2)observed+=chain.size()-1;
        if (observed!=group.edges.size())
            throw std::runtime_error("Shared border chain conservation failed: "+group.key);
        checked+=observed;
    }
    if (checked!=sources.size())
        throw std::runtime_error("Shared border chain dropped source edges");
    return checked;
}
} // namespace pandoeditor
