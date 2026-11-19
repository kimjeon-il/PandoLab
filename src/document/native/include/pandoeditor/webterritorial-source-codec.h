#pragma once
#include <pandoeditor/document.h>

namespace pandoeditor {
class ProjectSnapshot;
namespace codecjson { struct Value; }
namespace projectcodec { struct PlatformPorts; }

struct WebTerritorialFeature {
    TerritorialUnit identity;
    Geometry geometry;
    std::string parentId,coverageMode;
    Validity validity;
    ObjectStyle style;
    std::optional<CountryDetails> countryDetails;
    std::optional<TerritorialSymbolStyle> symbol;
};
// A typed current Web store intent. Common command prepare owns current-month
// admission, archive versions, records, dependencies and atomic publication.
struct WebTerritorialSource {
    std::vector<WebTerritorialFeature> features;
};
WebTerritorialSource readWebTerritorialSource(const codecjson::Value&,const projectcodec::PlatformPorts&);
codecjson::Value normalizeWebTerritorialResolvedFeature(const codecjson::Value&);
ProjectDocument applyWebTerritorialSource(const ProjectSnapshot&,const WebTerritorialSource&);
}
