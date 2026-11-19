#include <pandoeditor/webterritorial-source-codec.h>
#include <pandoeditor/projectcodec.h>
#include <pandoeditor/webcommands.h>
#include <algorithm>
#include <cctype>
#include <set>

namespace pandoeditor {
namespace {
using V=codecjson::Value;
const V& optional(const V& input,const char* name) {
    static const V missing;
    if(input.kind!=V::Object)return missing;
    const auto found=input.object.find(name);return found==input.object.end()?missing:found->second;
}
const V& required(const V& input,const char* name) {
    if(input.kind!=V::Object||!input.object.count(name))throw TimelineError("CORE_COMMAND_PAYLOAD",std::string("Missing territorial field: ")+name);
    return input.object.at(name);
}
std::string text(const V& input) {return trimWebText(webCommandString(input));}
std::string identity(const V& input) {
    auto id=text(input);if(id.empty())throw TimelineError("CORE_COMMAND_PAYLOAD","Territorial ID is empty.");return id;
}
V object(std::initializer_list<std::pair<const std::string,V>> fields) {
    auto result=V::obj();for(const auto& row:fields)result.object.emplace(row);return result;
}
std::optional<std::string> endpoint(const V& input) {
    const auto value=text(input);return value.empty()?std::nullopt:std::optional<std::string>{value};
}
V dateValue(const std::optional<std::string>& value) {return value?V::str(*value):V{};}
V annotations(const V& input,const char* field) {
    // The resolved normalizer supplies {} for scalars. Identity publication
    // rejects arrays, so never discard an array's annotation values here.
    if(input.kind==V::Array)throw TimelineError("CORE_COMMAND_PAYLOAD",std::string(field)+" must be an object.");
    return input.kind==V::Object?input:V::obj();
}
void polygon(const V& geometry) {
    const auto& type=required(geometry,"type"),&coordinates=required(geometry,"coordinates");
    if(type.kind!=V::String||(type.string!="Polygon"&&type.string!="MultiPolygon")||
       coordinates.kind!=V::Array||coordinates.array.empty())throw TimelineError("CORE_COMMAND_PAYLOAD","A territorial Polygon or MultiPolygon is required.");
}
V normalizedResolvedFeature(const V& input) {
    const auto& p=required(input,"properties");
    if(p.kind!=V::Object)throw TimelineError("CORE_COMMAND_PAYLOAD","Territorial properties must be an object.");
    const auto schema=webCommandNumber(optional(p,"schemaVersion"));
    if(!schema||*schema!=6)throw TimelineError("CORE_COMMAND_PAYLOAD","Territorial schemaVersion must be 6.");
    for(const auto* name:{"unitType","associatedCountryId","sovereignId"})if(p.object.count(name))
        throw TimelineError("CORE_COMMAND_PAYLOAD",std::string(name)+" is not a current territorial field.");
    auto kind=text(optional(p,"entityKind"));
    std::transform(kind.begin(),kind.end(),kind.begin(),[](unsigned char c){return char(std::tolower(c));});
    if(kind!="general"&&kind!="regional")throw TimelineError("CORE_COMMAND_PAYLOAD","Unsupported territorial entityKind.");
    const auto id=identity(required(input,"id")),parent=text(optional(p,"parentId")),coverage=text(optional(p,"coverageMode"));
    if(coverage!="explicit"&&coverage!="partition")throw TimelineError("CORE_COMMAND_PAYLOAD","Unsupported territorial coverageMode.");
    const auto interval=normalizeTemporalInterval(endpoint(optional(p,"validFrom")),endpoint(optional(p,"validTo")));
    auto style=annotations(optional(p,"style"),"style");const auto color=text(optional(style,"color"));
    if(color.empty())style.object.erase("color");else style.object["color"]=V::str(color);
    const auto& rawGeometry=required(input,"geometry");polygon(rawGeometry);
    auto normalized=object({{"type",V::str("Feature")},{"id",V::str(id)},{"geometry",rawGeometry},
        {"properties",object({{"schemaVersion",V::num(6)},{"entityKind",V::str(kind)},
        {"name",V::str(text(optional(p,"name")))},{"notes",V::str(text(optional(p,"notes")))},
        {"locked",V::boolean(optional(p,"locked").kind==V::Bool&&optional(p,"locked").raw=="true")},
        {"parentId",V::str(parent)},{"coverageMode",V::str(coverage)},
        {"validFrom",dateValue(interval.validFrom)},{"validTo",dateValue(interval.validTo)},
        {"style",std::move(style)},{"metadata",annotations(optional(p,"metadata"),"metadata")},
        {"sourceFolderId",V::str(text(optional(p,"sourceFolderId")))},
        {"sourceEntityId",V::str(text(optional(p,"sourceEntityId")))},
        {"sourceGeometryVersion",V::str(text(optional(p,"sourceGeometryVersion")))}})}});
    return normalized;
}
WebTerritorialFeature feature(const V& input,const projectcodec::PlatformPorts& ports) {
    return projectcodec::readWebTerritorialIdentityFeature(normalizedResolvedFeature(input),ports);
}
}
codecjson::Value normalizeWebTerritorialResolvedFeature(const codecjson::Value& value){return normalizedResolvedFeature(value);}
WebTerritorialSource readWebTerritorialSource(const V& payload,const projectcodec::PlatformPorts& ports) {
    const auto& rows=required(payload,"features");
    if(rows.kind!=V::Array)throw TimelineError("CORE_COMMAND_PAYLOAD","Territorial features must be an array.");
    WebTerritorialSource edit;std::set<std::string> seen;
    for(const auto& row:rows.array) {
        auto value=feature(row,ports);
        if(!seen.insert(value.identity.id).second)throw TimelineError("CORE_COMMAND_PAYLOAD","Duplicate territorial feature ID: "+value.identity.id);
        edit.features.push_back(std::move(value));
    }
    return edit;
}
}
