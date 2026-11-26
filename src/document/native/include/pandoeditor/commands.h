#pragma once
#include <pandoeditor/document.h>
#include <pandoeditor/webterritorial-source-codec.h>
#include <pandoeditor/gisexchange.h>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <variant>
#include <vector>

namespace pandoeditor {
class Project;
class ProjectSnapshot;
namespace detail { struct DocumentState; }

using ContentValue = std::variant<std::monostate, PlaceLabel, HydroFeature, DistributionLayer,
    DistributionEntry, GenericFeature, CountryDetails, TerritorialSymbolStyle>;
enum class CommandStatus { Applied, NoOp, Rejected };
enum class CommandError {
    None, ProjectMismatch, DocumentMismatch, StaleRevision, InvalidCommand,
    InvalidTargets, InvalidArguments, Locked,
    ValidationFailed, PrepareFailed, CommitFailed, RevisionOverflow
};
const char* commandErrorCode(CommandError error) noexcept;
// Calculated against validated immutable states during prepare. Candidate consumers
// may narrow their work; exact hit testing and document validation stay authoritative.
struct SceneDirtySet {
    bool geometry = false, presentation = false, interaction = false, datasetResource = false;
    std::vector<ObjectRef> affectedObjects, geometryObjects;
    bool fullRebuild = true;
};
struct ChangeImpact {
    std::vector<ObjectRef> changedObjects;
    std::vector<GeometryRef> changedGeometries;
    std::vector<ObjectRef> presentationInvalidations;
    std::size_t retainedGeometryCount = 0;
    std::size_t estimatedNewGeometryBytes = 0;
    bool requiresFullSpatialRebuild = false;
    bool requiresFullSceneRebuild = true;
    SceneDirtySet sceneDirty;
};
// Compare actual immutable states, including reverse history transitions.
ChangeImpact calculateChangeImpact(const ProjectDocument& before, const ProjectDocument& after,
                                   const std::vector<ObjectRef>& targets = {}, const std::string& month = {});
struct CommandResult {
    CommandStatus status = CommandStatus::Rejected;
    CommandError error = CommandError::None;
    std::string detail;
    ChangeImpact impact;
    std::string operationErrorCode;
    bool ok() const noexcept { return status!=CommandStatus::Rejected; }
    bool changed() const noexcept { return status==CommandStatus::Applied; }
};
} // namespace pandoeditor
