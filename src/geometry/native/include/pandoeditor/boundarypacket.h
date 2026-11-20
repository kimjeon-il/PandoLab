#pragma once
#include <pandoeditor/boundarychain.h>
#include <cstddef>
#include <string>
#include <vector>

namespace pandoeditor {
struct SharedStrokeSource {
    BoundaryEdge edge;
    std::vector<std::string> ownerIds;
};
// Offline cache integrity gate: exactly one chain edge per input edge.
std::size_t verifySharedStrokeChains(const std::vector<SharedStrokeSource>& sources);
}
