#pragma once
#include <pandoeditor/document.h>
#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace pandoeditor {
class ProjectSnapshot;
enum class GisCountryMergeStatus { Valid, Empty, InvalidIds };
struct GisCountryMergeIdentities {
    GisCountryMergeStatus status = GisCountryMergeStatus::Valid;
    std::size_t matched = 0; std::vector<int> existing; std::vector<std::size_t> unaffected;
};
GisCountryMergeIdentities planGisCountryMerge(const std::vector<std::u16string>& current,
    const std::vector<std::u16string>& incoming);
struct GisCountryMergeOperations {
    std::function<void()> prepare;
    std::function<bool(int, std::size_t)> bounds;
    std::function<std::optional<double>(int, std::size_t)> intersection;
    std::function<double()> area;
    std::function<bool(std::size_t)> subtract;
};
struct GisCountryMergeDonor { std::size_t index = 0; bool removed = false; };
struct GisCountryMergeGeometry { double overlapAreaKm2 = 0; std::vector<GisCountryMergeDonor> donors; };
GisCountryMergeGeometry planGisCountryGeometry(std::size_t incomingCount,
    const std::vector<std::size_t>& unaffected, bool replaceById, const GisCountryMergeOperations& operations);
bool gisCountryMergeCanCommit(double overlapAreaKm2) noexcept;
} // namespace pandoeditor
