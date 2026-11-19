#include <pandoeditor/document-session.h>
#include <limits>
#include <algorithm>
#include <pandoeditor/webterritorialcommands.h>
#include <pandoeditor/objectproperties.h>
#include <cmath>

namespace pandoeditor {
namespace {
// Domain-separated, length-delimited checksum of the actual C++ resolver
// result. Source SHA-256 independently pins every full geometry and property
// record; this small receipt never substitutes for the canonical resolver.
std::string temporalWorldSha256(const ResolvedWorld& world) {
    std::string bytes;
    bytes.reserve(world.entities.size()*180);
    const auto append=[&](const std::string& value) {
        bytes+=std::to_string(value.size());bytes+=':';bytes+=value;
    };
    const auto opt=[&](const std::optional<std::string>& value) {
        append(value?"1":"0");if(value)append(*value);
    };
    append("pando-core-temporal-world-v1");
    append(world.month);
    append(std::to_string(world.entities.size()));
    for(const auto& row:world.entities) {
        append(row.objectRef.domain);append(row.objectRef.id);
        append(row.geometryRef.id);append(std::to_string(row.geometryRef.version));
        append(row.rendering);append(row.parentId);append(row.coverageMode);append(row.rootId);
        append(std::to_string(row.ancestors.size()));
        for(const auto& parent:row.ancestors)append(parent);
        opt(row.validity.from);opt(row.validity.to);
        append(std::to_string(row.properties.size()));
        for(const auto& [key,value]:row.properties){append(key);append(value);}
    }
    return projectcodec::sha256Bytes(bytes);
}
} // namespace

DocumentSession::DocumentSession(projectcodec::PlatformPorts ports):ports_(std::move(ports)) {
    if(!ports_.validateFlagDataUrl)throw std::invalid_argument("CODEC_PLATFORM_REQUIRED: flag validator");
}
DocumentSessionState DocumentSession::adoptPreparedProject(Project&& project) {
    if(epoch_==std::numeric_limits<std::uint32_t>::max())throw std::overflow_error("CORE_SESSION_EPOCH_OVERFLOW");
    project_=std::move(project);clearTemporalSources();selection_.resetProject();
    externalSelectionRefs_.clear();loaded_=true;stateRevision_=0;sourceEpoch_=++epoch_;return projectState();
}
void DocumentSession::requireLoaded() const {
    if(!loaded_)throw std::invalid_argument("CORE_SESSION_UNLOADED: Load a document first.");
}
void DocumentSession::clearTemporalCandidate() noexcept { temporalCandidate_.reset(); }
void DocumentSession::clearTemporalSources() noexcept {
    clearTemporalCandidate();
    temporalSources_.clear();
    temporalSourceBytes_=0;
}
TemporalSourceStats DocumentSession::temporalSourceStats() const noexcept {
    return {temporalSources_.size(),temporalSourceBytes_,temporalSourceHits_,temporalSourceEvictions_};
}
TemporalSourceReceipt DocumentSession::temporalSourcePrepare(const projectcodec::WebStorageAssetSource& source,
    const std::string& dataRevision,const std::string& manifestSha256,std::uint32_t expectedEpoch) {
    requireEpoch(expectedEpoch);
    const bool validSha=manifestSha256.size()==64&&
        manifestSha256.find_first_not_of("0123456789abcdef")==std::string::npos;
    if(dataRevision.empty()||dataRevision.size()>128||!validSha)
        throw TimelineError("CORE_TEMPORAL_SOURCE_PIN","A pinned data revision and 64-digit manifest SHA-256 are required.");
    if(source.decodedBytes==0||source.decodedBytes>TEMPORAL_SOURCE_MAX_DECODED_BYTES)
        throw TimelineError("CORE_TEMPORAL_SOURCE_BUDGET","Immutable source exceeds the bounded decoded-byte budget.");
    if(source.compressedBytes==0||source.compressedBytes>256ull*1024*1024
        ||source.sourceBytes.size()!=source.compressedBytes)
        throw TimelineError("PL-SCHEMA-BASE","Immutable source byte counts are invalid.");
    const std::array<std::string,8> identity{source.baseDataset,dataRevision,manifestSha256,
        source.sourceMonth,source.fingerprint,source.encoding,
        std::to_string(source.compressedBytes),std::to_string(source.decodedBytes)};
    for(auto& [id,entry]:temporalSources_)if(entry.identity==identity) {
        // Never trust metadata alone on a cache hit: a caller can reuse a pin
        // while passing corrupt bytes. Re-hashing avoids a second typed parse.
        const std::string actual(reinterpret_cast<const char*>(source.sourceBytes.data()),source.sourceBytes.size());
        if(projectcodec::sha256Bytes(actual)!=source.fingerprint)
            throw TimelineError("PL-SCHEMA-BASE","Immutable source bytes do not match the claimed fingerprint.");
        entry.access=++temporalSourceAccess_;
        ++temporalSourceHits_;
        return {id,entry.baseline.sourceMonth(),entry.baseline.fingerprint(),true};
    }
    if(temporalSourceSequence_==std::numeric_limits<std::uint32_t>::max())
        throw std::overflow_error("CORE_TEMPORAL_SOURCE_OVERFLOW");
    // Validates exact compressed bytes, hash, codec, source month, typed
    // document, geometry and provenance using the current C++ source codec.
    // Unlike storageBaselineLoad, this NEVER modifies the active Project,
    // storageBaseline_, activeBaseline_, epoch, selection, edit or history.
    auto baseline=projectcodec::admitWebStorageAssetBaseline(project_.snapshot(),source,ports_);
    const auto newId=temporalSourceSequence_+1;
    while(!temporalSources_.empty() &&
        (temporalSources_.size()>=TEMPORAL_SOURCE_MAX_ENTRIES ||
          temporalSourceBytes_>TEMPORAL_SOURCE_MAX_DECODED_BYTES-source.decodedBytes)) {
        auto oldest=std::min_element(temporalSources_.begin(),temporalSources_.end(),
            [](const auto& left,const auto& right){return left.second.access<right.second.access;});
        temporalSourceBytes_-=oldest->second.declaredDecodedBytes;
        if(temporalCandidate_&&temporalCandidate_->receipt.sourceId==oldest->first)
            clearTemporalCandidate();
        temporalSources_.erase(oldest);
        ++temporalSourceEvictions_;
    }
    temporalSources_.emplace(newId,TemporalSourceEntry{identity,std::move(baseline),
        source.decodedBytes,++temporalSourceAccess_});
    temporalSourceSequence_=newId;
    temporalSourceBytes_+=source.decodedBytes;
    const auto& admitted=temporalSources_.at(newId).baseline;
    return {newId,admitted.sourceMonth(),admitted.fingerprint(),false};
}
std::optional<projectcodec::WebStorageBaseline> DocumentSession::temporalSourceLookup(
    std::uint32_t id,std::uint32_t expectedEpoch) const {
    requireEpoch(expectedEpoch);
    const auto found=temporalSources_.find(id);
    if(found==temporalSources_.end())return std::nullopt;
    // Return the existing shared immutable source, not a borrowed pointer
    // that would dangle if a future request evicts its registry slot.
    return found->second.baseline;
}
bool DocumentSession::temporalSourceRelease(std::uint32_t id,std::uint32_t expectedEpoch) {
    requireEpoch(expectedEpoch);
    const auto found=temporalSources_.find(id);
    if(found==temporalSources_.end())return false;
    temporalSourceBytes_-=found->second.declaredDecodedBytes;
    if(temporalCandidate_&&temporalCandidate_->receipt.sourceId==id)clearTemporalCandidate();
    temporalSources_.erase(found);
    return true;
}
TemporalCandidateReceipt DocumentSession::temporalCandidatePrepare(
    std::uint32_t sourceId,const std::string& targetMonth,
    const std::string& sourceFingerprint,std::uint32_t expectedEpoch,
    std::optional<codecjson::Value> setup,const std::string& documentId) {
    requireEpoch(expectedEpoch);
    const auto found=temporalSources_.find(sourceId);
    if(found==temporalSources_.end()||!found->second.baseline.sourceDocument())
        throw TimelineError("CORE_TEMPORAL_CANDIDATE_SOURCE","The verified immutable temporal source is absent.");
    const auto& source=found->second.baseline;
    if(sourceFingerprint!=source.fingerprint())
        throw TimelineError("CORE_TEMPORAL_CANDIDATE_PIN","The temporal candidate source fingerprint changed.");
    const auto date=parseTemporal(targetMonth);
    if(date.precision!="month"||date.canonical!=targetMonth||source.sourceMonth()!=targetMonth)
        throw TimelineError("CORE_TEMPORAL_CANDIDATE_MONTH","Candidate month must match its exact stored source month.");
    if(setup.has_value()!=!documentId.empty())
        throw TimelineError("CORE_TEMPORAL_CANDIDATE_SETUP","A prepared builtin setup and document ID must be supplied together.");
    codecjson::Value verifiedSetup;
    std::string setupKey;
    if(setup) {
        verifiedSetup=projectcodec::validateProjectSetup(*setup);
        if(verifiedSetup.object.at("sourceMode").string!="builtin"
            ||verifiedSetup.object.at("initialMonth").string!=targetMonth)
            throw TimelineError("CORE_TEMPORAL_CANDIDATE_SETUP","The builtin project setup must match the exact candidate month.");
        setupKey=verifiedSetup.encode();
    }
    const bool transition=setup&&documentId==project_.document().documentId;
    if(transition) {
        const auto header=codecjson::parse(project_.document().exchangeMetadata);
        const auto activeSetup=header.object.find("projectSetup");
        if(!activeBaseline_||activeBaseline_->kind()!=projectcodec::WebStorageBaselineKind::Builtin
            ||activeSetup==header.object.end()||activeSetup->second.kind!=codecjson::Value::Object
            ||!activeSetup->second.object.count("sourceMode")
            ||activeSetup->second.object.at("sourceMode").string!="builtin")
            throw TimelineError("CORE_BUILTIN_TRANSITION","A clean active builtin Viewer source is required for identity-preserving transition.");
    }
    if(temporalCandidate_&&temporalCandidate_->receipt.sourceId==sourceId
        &&temporalCandidate_->receipt.expectedEpoch==expectedEpoch
        &&temporalCandidate_->receipt.sourceFingerprint==sourceFingerprint
        &&temporalCandidate_->receipt.targetMonth==targetMonth
        &&temporalCandidate_->preparedSetupKey==setupKey
        &&temporalCandidate_->preparedDocumentId==documentId) {
        auto receipt=temporalCandidate_->receipt;
        receipt.reused=true;
        return receipt;
    }
    // A newer request invalidates an earlier candidate even if its C++
    // validation or world projection subsequently fails.
    clearTemporalCandidate();
    if(temporalCandidateSequence_==std::numeric_limits<std::uint32_t>::max())
        throw std::overflow_error("CORE_TEMPORAL_CANDIDATE_OVERFLOW");
    auto staged=std::make_unique<TemporalCandidateEntry>();
    // Prepare the *final* document and all expensive Core projections before
    // the replacement capsule is acquired. The old full baseline loader's
    // setup, provenance and new-document semantics remain authoritative.
    auto document=*source.sourceDocument();
    if(setup) {
        document.dirtyTerritorialIds.clear();
        GeometryProvenanceCodecAccess::setProjectSetupMetadata(document,verifiedSetup);
        document.documentId=documentId;
    }
    staged->project.replace(std::move(document));
    staged->world=staged->project.resolveWorld(targetMonth);
    staged->project.setTimelineCursor(targetMonth,true,&staged->world);
    if(transition) {
        for(const auto& [ref,shape]:staged->project.document().geometries.versions()) {
            const auto previous=project_.document().geometries.get(ref);
            if(previous&&previous!=shape&&!sameGeometryValue(*previous,*shape))
                throw TimelineError("CORE_BUILTIN_GEOMETRY_VERSION","A temporal source cannot rewrite an immutable geometry version.");
        }
        const auto impact=calculateChangeImpact(project_.document(),staged->project.document(),{},targetMonth);
        // Prepare the authoritative wire delta before entering the replacement
        // transaction. Initial/file adoption continues to publish a full model.
        staged->preparedDelta=projectcodec::encodeWebDelta(project_.document(),staged->project.document(),impact);
    }
    staged->preparedSetupKey=setupKey;
    staged->preparedDocumentId=documentId;
    staged->adoptionReady=setup.has_value();
    const auto sha=temporalWorldSha256(staged->world);
    const auto candidateId=temporalCandidateSequence_+1;
    staged->receipt={candidateId,sourceId,expectedEpoch,targetMonth,
        sourceFingerprint,sha,staged->world.entities.size(),false};
    temporalCandidate_=std::move(staged);
    temporalCandidateSequence_=candidateId;
    return temporalCandidate_->receipt;
}
std::optional<TemporalCandidateInspection> DocumentSession::temporalCandidateInspect(
    std::uint32_t candidateId,std::uint32_t expectedEpoch) const {
    requireEpoch(expectedEpoch);
    if(!temporalCandidate_||temporalCandidate_->receipt.candidateId!=candidateId
        ||temporalCandidate_->receipt.expectedEpoch!=expectedEpoch)return std::nullopt;
    const auto found=temporalSources_.find(temporalCandidate_->receipt.sourceId);
    if(found==temporalSources_.end()
        ||found->second.baseline.fingerprint()!=temporalCandidate_->receipt.sourceFingerprint
        ||found->second.baseline.sourceMonth()!=temporalCandidate_->receipt.targetMonth)
        return std::nullopt;
    return TemporalCandidateInspection{
        projectcodec::webSnapshot(temporalCandidate_->project.snapshotForView()),
        temporalCandidate_->world};
}
bool DocumentSession::temporalCandidateDiscard(std::uint32_t candidateId,std::uint32_t expectedEpoch) {
    requireEpoch(expectedEpoch);
    if(!temporalCandidate_||temporalCandidate_->receipt.candidateId!=candidateId)return false;
    clearTemporalCandidate();
    return true;
}
DocumentSessionState DocumentSession::temporalCandidateAdopt(
    std::uint32_t candidateId,std::uint32_t sourceId,const std::string& targetMonth,
    const std::string& sourceFingerprint,const std::string& worldSha256,
    std::uint32_t replacementId,std::uint32_t expectedEpoch,std::string* acceptedDelta) {
    requireEpoch(expectedEpoch);
    // Validate the *same* capsule that ProjectDomain already owns, before
    // changing any state. A missing or superseded capsule never commits.
    if(!replacement_||replacementId==0||replacementId!=replacementId_)
        throw TimelineError("CORE_TEMPORAL_CANDIDATE_CAPSULE","The current Core replacement checkpoint is required.");
    if(!temporalCandidate_||!temporalCandidate_->adoptionReady
        ||candidateId==0||candidateId!=temporalCandidate_->receipt.candidateId
        ||expectedEpoch!=temporalCandidate_->receipt.expectedEpoch)
        throw TimelineError("CORE_TEMPORAL_CANDIDATE_STALE","A prepared builtin temporal candidate is required.");
    const auto& receipt=temporalCandidate_->receipt;
    if(sourceId!=receipt.sourceId||targetMonth!=receipt.targetMonth
        ||sourceFingerprint!=receipt.sourceFingerprint||worldSha256!=receipt.worldSha256)
        throw TimelineError("CORE_TEMPORAL_CANDIDATE_PIN","The requested temporal candidate receipt differs from its prepared Core source.");
    const auto found=temporalSources_.find(sourceId);
    if(found==temporalSources_.end()||!found->second.baseline.sourceDocument()
        ||found->second.baseline.fingerprint()!=receipt.sourceFingerprint
        ||found->second.baseline.sourceMonth()!=receipt.targetMonth)
        throw TimelineError("CORE_TEMPORAL_CANDIDATE_SOURCE","The source was released or replaced before adoption.");
    if(temporalCandidate_->project.timelineCursor()!=targetMonth
        ||temporalCandidate_->project.document().documentId!=temporalCandidate_->preparedDocumentId
        ||temporalWorldSha256(temporalCandidate_->world)!=worldSha256
        ||temporalCandidate_->world.entities.size()!=receipt.resolvedEntityCount)
        throw TimelineError("CORE_TEMPORAL_CANDIDATE_STALE","The prepared world no longer matches its verified receipt.");
    if(epoch_==std::numeric_limits<std::uint32_t>::max()
        ||storageBaselineSequence_==std::numeric_limits<std::uint32_t>::max())
        throw std::overflow_error("CORE_TEMPORAL_ADOPT_OVERFLOW");
    // Both handles share validated, immutable typed source data. All checks
    // and allocations above happen before this non-interruptible Core commit.
    // The old Project/selection/draft/baseline/history remain in replacement_.
    auto admittedSource=found->second.baseline;
    if(acceptedDelta)*acceptedDelta=std::move(temporalCandidate_->preparedDelta);
    project_=std::move(temporalCandidate_->project);
    storageBaseline_=admittedSource;
    activeBaseline_=std::move(admittedSource);
    storageBaselineId_=++storageBaselineSequence_;
    loaded_=true;
    stateRevision_=0;
    clearTemporalSources(); // Prevent cross-generation source/candidate reuse.
    selection_.resetProject();
    externalSelectionRefs_.clear();
    sourceEpoch_=++epoch_;
    return projectState();
}
DocumentSessionState DocumentSession::documentLoad(const std::string& input,const std::string& currentMonth) {
    if(epoch_==std::numeric_limits<std::uint32_t>::max())throw std::overflow_error("CORE_SESSION_EPOCH_OVERFLOW");
    auto document=projectcodec::decodeWebStorage(input,ports_,storageBaseline_?&*storageBaseline_:nullptr);
    const auto month=projectcodec::restoredTimelineMonth(document);
    // Both decoding and Project::replace build a validated candidate before the
    // canonical state changes. No partially parsed document can publish.
    const bool resumeEditing=!isStaticTimeline(document);
    Project candidate;candidate.replace(std::move(document));candidate.setTimelineCursor(month,resumeEditing);
    const auto header=codecjson::parse(candidate.document().exchangeMetadata);
    auto active=storageBaseline_&&header.object.at("baseDataset").string==storageBaseline_->baseDataset()?storageBaseline_:
        std::optional<projectcodec::WebStorageBaseline>{projectcodec::admitWebStorageDocumentBaseline(candidate.snapshot(),ports_)};
    candidate.admitTerritorialDirtyIds([&](const ProjectDocument& d){return projectcodec::initialDirtyTerritorialIds(d,*active);});
    project_=std::move(candidate);activeBaseline_=std::move(active);
    clearTemporalSources();selection_.resetProject();externalSelectionRefs_.clear();
    loaded_=true;sourceEpoch_=++epoch_;stateRevision_=0;
    return projectState();
}
std::string DocumentSession::storageSnapshot() const { requireLoaded();return projectcodec::encodeWeb(project_.snapshot(),ports_); }
std::string DocumentSession::documentSnapshot() const {requireLoaded();return projectcodec::webSnapshot(project_.snapshot());}
DocumentSessionState DocumentSession::storageBaselineLoad(const codecjson::Value& input,std::uint32_t expectedEpoch) {
    requireEpoch(expectedEpoch);if(epoch_==std::numeric_limits<std::uint32_t>::max()||storageBaselineSequence_==std::numeric_limits<std::uint32_t>::max())throw std::overflow_error("CORE_SESSION_EPOCH_OVERFLOW");
    auto baseline=projectcodec::admitWebStorageBaseline(project_.snapshot(),input,ports_);
    const auto header=codecjson::parse(project_.document().exchangeMetadata);
    if(header.object.at("baseDataset").string==baseline.baseDataset()) {
        project_.admitTerritorialDirtyIds([&](const ProjectDocument& document){return projectcodec::initialDirtyTerritorialIds(document,baseline);});
        activeBaseline_=baseline;
    }
    storageBaseline_=std::move(baseline);storageBaselineId_=++storageBaselineSequence_;++epoch_;return projectState();
}
DocumentSessionState DocumentSession::storageBaselineLoad(const projectcodec::WebStorageAssetSource& input,std::uint32_t expectedEpoch) {
    requireEpoch(expectedEpoch);if(epoch_==std::numeric_limits<std::uint32_t>::max()||storageBaselineSequence_==std::numeric_limits<std::uint32_t>::max())throw std::overflow_error("CORE_SESSION_EPOCH_OVERFLOW");
    auto baseline=projectcodec::admitWebStorageAssetBaseline(project_.snapshot(),input,ports_);
    storageBaseline_=std::move(baseline);storageBaselineId_=++storageBaselineSequence_;++epoch_;return projectState();
}
DocumentSessionState DocumentSession::admitExternalBaseline(std::uint32_t expectedEpoch) {
    requireEpoch(expectedEpoch);
    const auto header=codecjson::parse(project_.document().exchangeMetadata);
    if(storageBaseline_&&header.object.at("baseDataset").string==storageBaseline_->baseDataset())return projectState();
    if(epoch_==std::numeric_limits<std::uint32_t>::max())throw std::overflow_error("CORE_SESSION_EPOCH_OVERFLOW");
    auto baseline=projectcodec::admitWebStorageDocumentBaseline(project_.snapshot(),ports_);
    project_.admitTerritorialDirtyIds([&](const ProjectDocument& document){return projectcodec::initialDirtyTerritorialIds(document,baseline);});
    activeBaseline_=std::move(baseline);++epoch_;return projectState();
}
ResolvedWorld DocumentSession::baselineWorld(std::uint32_t id,const std::string& month) const {
    if(!storageBaseline_||id!=storageBaselineId_||!storageBaseline_->sourceDocument())throw TimelineError("PL-SCHEMA-BASE","Baseline source is absent or replaced.");
    Project staged;staged.replace(*storageBaseline_->sourceDocument());return staged.resolveWorld(month);
}
DocumentSessionState DocumentSession::documentLoadBaseline(std::uint32_t id,const codecjson::Value& options,const std::string& documentId) {
    if(!storageBaseline_||id!=storageBaselineId_||!storageBaseline_->sourceDocument())throw TimelineError("PL-SCHEMA-BASE","The full accepted baseline source is absent or replaced.");
    if(epoch_==std::numeric_limits<std::uint32_t>::max())throw std::overflow_error("CORE_SESSION_EPOCH_OVERFLOW");
    auto document=*storageBaseline_->sourceDocument();document.dirtyTerritorialIds.clear();
    const auto before=document;const auto setup=projectcodec::validateProjectSetup(options);auto header=codecjson::parse(document.exchangeMetadata);header.object["projectSetup"]=setup;
    if(setup.object.at("sourceMode").string=="empty") {
        document.units.clear();document.countryDetails.clear();document.symbols.clear();document.labels.clear();document.hydro.clear();document.genericFeatures.clear();document.distributionLayers.clear();document.distributionEntries.clear();
        document.timelineRecords=TimelineRecords{};document.geometries=GeometryStore{};document.geometryProvenance=GeometryProvenance{};document.presentation=PresentationState{};
        header.object["baseDataset"]=codecjson::Value::str("external-territorial-entities");header.object["sourceInfo"]=codecjson::Value{};
    }
    document.exchangeMetadata=header.encode();
    if(setup.object.at("sourceMode").string=="builtin")GeometryProvenanceCodecAccess::admitProjectSetupMetadata(before,document);
    if(documentId.empty())throw TimelineError("INVALID_DOCUMENT_ID","New document ID is required.");document.documentId=documentId;
    const auto month=setup.object.at("initialMonth").string;Project candidate;candidate.replace(std::move(document));candidate.setTimelineCursor(month,true);
    project_=std::move(candidate);activeBaseline_=storageBaseline_;loaded_=true;stateRevision_=0;
    clearTemporalCandidate(); // A full accepted replacement supersedes this read-only candidate.
    selection_.resetProject();externalSelectionRefs_.clear();sourceEpoch_=++epoch_;return projectState();
}
DocumentSessionState DocumentSession::documentInitialize(const std::string& input,const std::string& currentMonth,bool preserveCursor,
        const std::optional<codecjson::Value>& features,const std::optional<std::string>& territorialSource,std::uint32_t expectedEpoch,std::optional<std::uint32_t> baselineId) {
    if(loaded_)requireEpoch(expectedEpoch);else if(expectedEpoch!=0)throw std::invalid_argument("STALE_REVISION: unloaded session epoch must be zero");
    if(unsigned(bool(features))+unsigned(bool(territorialSource))+unsigned(bool(baselineId))>1)throw std::invalid_argument("CORE_SOURCE_ADMISSION: source protocols are mutually exclusive");
    if(baselineId&&(!storageBaseline_||*baselineId!=storageBaselineId_||!storageBaseline_->sourceDocument()))throw TimelineError("PL-SCHEMA-BASE","Accepted baseline source is absent or replaced.");
    if(epoch_==std::numeric_limits<std::uint32_t>::max())throw std::overflow_error("CORE_SESSION_EPOCH_OVERFLOW");
    auto content=loaded_?project_.document():projectcodec::readWebSnapshot(input,ports_);
    ProjectDocument source;
    if(baselineId)source=*storageBaseline_->sourceDocument();
    else if(territorialSource)source=projectcodec::decodeWeb(*territorialSource,ports_);
    else if(features) {
        ProjectDocument empty;empty.documentId=content.documentId;empty.exchangeMetadata=content.exchangeMetadata;
        Project staged;staged.replace(std::move(empty));auto payload=codecjson::Value::obj();payload.object["features"]=*features;
        const auto sourceRows=readWebTerritorialSource(payload,ports_);
        source=applyWebTerritorialSource(staged.snapshot(),sourceRows);
    }else source=projectcodec::readWebSnapshot(input,ports_);
    const auto month=loaded_&&preserveCursor?project_.timelineCursor():initialTimelineMonth(source.timelineRecords,currentMonth);
    auto document=projectcodec::replaceWebTerritorialSource(content,source,month);
    std::optional<projectcodec::WebStorageBaseline> active;
    if(baselineId)active=storageBaseline_;
    else {Project sourceProject;sourceProject.replace(source);sourceProject.setTimelineCursor(month,false);
        active=projectcodec::admitWebStorageDocumentBaseline(sourceProject.snapshot(),ports_);}
    document.dirtyTerritorialIds=active?projectcodec::initialDirtyTerritorialIds(document,*active):std::vector<std::string>{};
    const bool activated=!isStaticTimeline(document)||(loaded_&&preserveCursor&&project_.timelineEditsEnabled());
    if(loaded_)project_.admitTerritorialSource(std::move(document),month,activated);
    else {Project candidate;candidate.replace(std::move(document));candidate.setTimelineCursor(month,activated);project_=std::move(candidate);loaded_=true;}
    activeBaseline_=active;clearTemporalSources();selection_.prune([&](const SelectionRef& ref){return selectionRefExists(ref);});sourceEpoch_=++epoch_;return projectState();
}
std::uint32_t DocumentSession::captureReplacement(std::uint32_t expectedEpoch) {
    requireEpoch(expectedEpoch);if(replacementSequence_==std::numeric_limits<std::uint32_t>::max())throw std::overflow_error("CORE_REPLACEMENT_OVERFLOW");
    Replacement next{project_.captureReplacement(),selection_,externalSelectionRefs_,storageBaseline_,activeBaseline_,storageBaselineId_,stateRevision_};
    replacement_=std::move(next);replacementId_=++replacementSequence_;return replacementId_;
}
DocumentSessionState DocumentSession::rollbackReplacement(std::uint32_t id,std::uint32_t expectedEpoch) {
    requireEpoch(expectedEpoch);if(!replacement_||id!=replacementId_)throw std::invalid_argument("CORE_REPLACEMENT_ABSENT");
    if(epoch_==std::numeric_limits<std::uint32_t>::max())throw std::overflow_error("CORE_SESSION_EPOCH_OVERFLOW");
    project_.restoreReplacement(replacement_->project);selection_=std::move(replacement_->selection);
    externalSelectionRefs_=std::move(replacement_->externalSelectionRefs);
    storageBaseline_=std::move(replacement_->storageBaseline);
    activeBaseline_=std::move(replacement_->activeBaseline);storageBaselineId_=replacement_->storageBaselineId;
    stateRevision_=replacement_->stateRevision;
    replacement_.reset();replacementId_=0;clearTemporalSources();sourceEpoch_=++epoch_;return projectState();
}
bool DocumentSession::releaseReplacement(std::uint32_t id) {if(!replacement_||id!=replacementId_)return false;replacement_.reset();replacementId_=0;return true;}
DocumentSessionState DocumentSession::projectState() const {
    requireLoaded();DocumentSessionState state;
    state.epoch=epoch_;state.stateRevision=stateRevision_;state.revision=project_.revision();
    state.timelineCursor=project_.timelineCursor();
    state.presentationRevision=project_.presentationRevision();
    state.timelineEditsEnabled=project_.timelineEditsEnabled();state.dirtyTerritorialIds=project_.document().dirtyTerritorialIds;state.storageBaselineId=storageBaselineId_;return state;
}
DocumentSessionOutcome DocumentSession::presentationCatalogLoad(PresentationCatalog catalog,std::uint32_t expectedEpoch) {
    requireEpoch(expectedEpoch);
    for(const auto& [id,category]:catalog.hydroLayers)
        if(trimWebText(id).empty()||(category!="river"&&category!="lake"))throw TimelineError("CORE_PRESENTATION_CATALOG","Invalid physical layer identity/category.");
    std::set<std::string> labels;
    for(const auto& id:catalog.countryLabelIds)if(trimWebText(id).empty()||!labels.insert(id).second)
        throw TimelineError("CORE_PRESENTATION_CATALOG","Invalid country-label identity.");
    for(const auto& [id,source]:catalog.builtinSubunitSources)
        if(trimWebText(id).empty()||trimWebText(source).empty())
            throw TimelineError("CORE_PRESENTATION_CATALOG","Invalid builtin subunit source identity.");
    if(epoch_==std::numeric_limits<std::uint32_t>::max())throw std::overflow_error("CORE_SESSION_EPOCH_OVERFLOW");
    auto candidate=project_.document();candidate.presentation.catalog=std::make_shared<const PresentationCatalog>(std::move(catalog));
    std::map<std::string,std::set<std::string>> valid;
    for(const auto& row:candidate.units)valid["objects"].insert(row.id);
    for(const auto& row:candidate.labels)valid["labels"].insert(row.id);
    for(const auto& row:candidate.hydro)valid["hydro"].insert(row.id);
    for(const auto& row:candidate.genericFeatures)valid["genericFeatures"].insert(row.id);
    for(const auto& row:candidate.distributionLayers)valid["distributions"].insert(row.id);
    for(const auto& [id,kind]:candidate.presentation.catalog->hydroLayers)valid["hydro"].insert(id);
    for(const auto& id:candidate.presentation.catalog->countryLabelIds)valid["objectLabels"].insert(id);
    auto& hidden=candidate.presentation.webPresentation.itemVisibility;
    for(const auto* group:{"objects","objectLabels","labels","hydro","genericFeatures","distributions"}) {
        auto& ids=hidden[group];for(auto it=ids.begin();it!=ids.end();)if(!valid[group].count(it->first))it=ids.erase(it);else ++it;
    }
    auto impact=calculateChangeImpact(project_.document(),candidate,{},project_.timelineCursor());
    auto delta=projectcodec::encodeWebDelta(project_.document(),candidate,impact);
    project_.admitPresentation(std::move(candidate));++epoch_;
    DocumentSessionOutcome outcome;outcome.result.status=CommandStatus::Applied;outcome.result.impact=std::move(impact);outcome.delta=std::move(delta);return outcome;
}
ResolvedWorld DocumentSession::resolveWorld(const std::string& month) const { requireLoaded();return project_.resolveWorld(month); }
std::vector<GeometryRef> DocumentSession::geometryRequirements(const std::string& month,std::uint32_t expectedEpoch) const {
    requireEpoch(expectedEpoch);return project_.missingGeometries(month);
}
std::string DocumentSession::admitGeometryResources(const std::vector<std::pair<GeometryRef,std::string>>& payloads,std::uint32_t expectedEpoch) {
    requireEpoch(expectedEpoch);GeometryStore admitted;ChangeImpact impact;auto candidate=project_.document();
    for(const auto& [ref,bytes]:payloads) {
        const auto found=candidate.geometries.resources().find(ref);
        if(found==candidate.geometries.resources().end())throw std::invalid_argument("INVALID_GEOMETRY_RESOURCE: undeclared reference");
        auto geometry=projectcodec::decodeGeometryResource(found->second,bytes);
        admitted.declareResource(ref,found->second);
        admitted.insertCanonical(ref,std::move(geometry));
        if(!candidate.geometries.get(ref)){candidate.geometries.retainFrom(admitted,ref,ref);impact.changedGeometries.push_back(ref);}
    }
    const auto delta=projectcodec::encodeWebDelta(project_.document(),candidate,impact);
    project_.admitGeometryResources(admitted);return delta;
}
bool DocumentSession::setTimelineCursor(const std::string& month,std::uint32_t expectedEpoch,ResolvedWorld* resolvedForResponse) {
    requireLoaded();if(expectedEpoch!=epoch_)throw std::invalid_argument("STALE_REVISION: session epoch changed");
    if(epoch_==std::numeric_limits<std::uint32_t>::max())throw std::overflow_error("CORE_SESSION_EPOCH_OVERFLOW");
    // Resolve exactly once. The same temporal result prunes selection, builds
    // the static view and forms the Worker response at the new session epoch.
    const auto world=project_.resolveWorld(month);auto nextSelection=selection_;
    nextSelection.prune([&](const SelectionRef& ref){return (ref.domain=="territorial"||ref.domain=="hydro")?world.find(ObjectRef{ref.domain,ref.id})!=nullptr:selectionRefExists(ref);});
    // Construct the outbound copy before modifying Project, preserving the
    // existing strong exception boundary if a large allocation fails.
    if(resolvedForResponse)*resolvedForResponse=world;
    const bool cursorChanged=project_.timelineCursor()!=month;
    if(!project_.setTimelineCursor(month,true,&world))return false;
    sourceEpoch_=++epoch_;selection_=std::move(nextSelection);return cursorChanged;
}
void DocumentSession::requireEpoch(std::uint32_t expectedEpoch) const {
    requireLoaded();if(expectedEpoch!=epoch_)throw std::invalid_argument("STALE_REVISION: session epoch changed");
}
DocumentSessionOutcome DocumentSession::selectionCatalogLoad(const std::string& domain,const std::vector<SelectionCatalogEntry>& refs,std::uint32_t expectedEpoch) {
    requireEpoch(expectedEpoch);if(domain!="placeBuiltin"&&domain!="hydroBuiltin")throw std::invalid_argument("CORE_SELECTION_CATALOG: expected an external domain");
    auto catalog=externalSelectionRefs_;
    for(auto i=catalog.begin();i!=catalog.end();)if(i->first.domain==domain)i=catalog.erase(i);else ++i;
    for(const auto& entry:refs) {
        const auto& ref=entry.ref;
        if(ref.domain!=domain||ref.id.empty()||ref.type.empty()||(entry.logicalId&&entry.logicalId->empty())||!catalog.emplace(ref,entry.logicalId).second)
            throw std::invalid_argument("CORE_SELECTION_CATALOG: invalid or duplicate external identity");
        if(domain!="hydroBuiltin"&&!entry.sourceIds.empty())throw std::invalid_argument("CORE_SELECTION_CATALOG: source IDs belong to hydro");
        for(const auto& source:entry.sourceIds)if(source.empty())throw std::invalid_argument("CORE_SELECTION_CATALOG: empty hydro source ID");
        if(!entry.sourceIds.empty()&&!entry.logicalId)throw std::invalid_argument("CORE_SELECTION_CATALOG: hydro aliases need explicit logical ID");
    }
    auto selected=selection_;selected.prune([&](const SelectionRef& ref){return ref.domain!=domain||catalog.count(ref)!=0;});
    auto candidate=project_.document();
    if(domain=="hydroBuiltin"&&std::any_of(refs.begin(),refs.end(),[](const auto& row){return !row.sourceIds.empty();})) {
        auto& hidden=candidate.presentation.webPresentation.itemVisibility["hydro"];
        for(const auto& entry:refs)if(entry.logicalId) {
            bool alias=false;for(const auto& row:hidden) {
                const auto& key=row.first;const auto suffix=key.substr(key.find_last_of(':')==std::string::npos?0:key.find_last_of(':')+1);
                if(key!=*entry.logicalId&&!row.second&&std::find(entry.sourceIds.begin(),entry.sourceIds.end(),suffix)!=entry.sourceIds.end()){alias=true;break;}
            }
            if(alias)hidden[*entry.logicalId]=false;
        }
    }
    DocumentSessionOutcome outcome;outcome.result.status=CommandStatus::NoOp;
    if(candidate.exchangeMetadata!=project_.document().exchangeMetadata) {
        GeometryProvenanceCodecAccess::admitPresentationMetadata(project_.document(),candidate);
        outcome.result.impact=calculateChangeImpact(project_.document(),candidate,{},project_.timelineCursor());
        outcome.delta=projectcodec::encodeWebDelta(project_.document(),candidate,outcome.result.impact);
        project_.admitPresentation(std::move(candidate),false);outcome.result.status=CommandStatus::Applied;
    }
    externalSelectionRefs_=std::move(catalog);selection_=std::move(selected);
    return outcome;
}
bool DocumentSession::selectionRefExists(const SelectionRef& ref) const {
    const ObjectRef object{ref.domain,ref.id};
    return project_.hasActiveObject(object)||externalSelectionRefs_.count(ref)!=0;
}
}
