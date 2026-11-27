#include <pandoeditor/projectcodec.h>
#include "projectcodec-detail.h"
#include <pandoeditor/timeline-storage.h>
#include <pandoeditor/timeline-resolver.h>
#include <pandoeditor/geometryprovenance.h>
#include <pandoeditor/webcommands.h>


#include <pandoeditor/objectproperties.h>
#include <pandoeditor/losslessjson.h>





#include <climits>
#include <regex>
#include <array>
#include <charconv>
#include <iomanip>
#include <sstream>
#include <algorithm>
#include <limits>
#include <cmath>
#include <set>

namespace pandoeditor::projectcodec {
using namespace codec_detail;
namespace codec_detail {
V currentWebHeader();
void validateHeader(const V&,const ProjectDocument&);
void validateExchangeMetadata(const ProjectDocument&);
bool presentationGroup(const std::string& key) {
    return std::set<std::string>{"objects","distributions","rivers","lakes","hydro","genericFeatures","labels","objectLabels","terrain"}.count(key);
}
// Current web project-state.js has distinct layer/item/style namespaces.
// Native presentation retains its broader key set for native-only documents.
bool webLayerVisibilityKey(const std::string& key) {
    static const std::set<std::string> keys={"objects","distributions","rivers","lakes","genericFeatures","labels","objectNames"};
    return keys.count(key);
}
bool webItemVisibilityKey(const std::string& key) {
    static const std::set<std::string> keys={"objects","distributions","hydro","genericFeatures","labels","objectLabels"};
    return keys.count(key);
}
V object(std::initializer_list<std::pair<const std::string,V>> entries) { V v=V::obj(); v.object=entries; return v; }
const V& field(const V& v,const std::string& key) {
    require(v.kind==V::Object,"INVALID_JSON: expected object");
    const auto it=v.object.find(key); require(it!=v.object.end(),"INVALID_JSON: missing required field"); return it->second;
}
std::string str(const V& v) { require(v.kind==V::String,"INVALID_JSON: expected string"); return v.string; }
void validateEmbeddedFlag(const std::string& value,const PlatformPorts& ports) {
    require(bool(ports.validateFlagDataUrl),"CODEC_PLATFORM_REQUIRED: flag validator");
    ports.validateFlagDataUrl(value);
}
bool webObjectId(const std::string& id) {
    static const std::regex pattern("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$");
    auto value=id;if(!value.empty()&&value.back()=='\n')value.pop_back();
    return std::regex_match(value,pattern);
}
void validateWebObjectIds(const ProjectDocument& d) {
    const auto rows=[&](const auto& values){for(const auto& value:values)require(webObjectId(value.id),"INVALID_WEB_OBJECT_UUID");};
    rows(d.labels);rows(d.hydro);rows(d.genericFeatures);rows(d.distributionLayers);rows(d.distributionEntries);
}
bool boolean(const V& v) { require(v.kind==V::Bool,"INVALID_JSON: expected boolean"); return v.raw=="true"; }
double number(const V& v) { return codecjson::finiteNumber(v); }
std::uint32_t integer(const V& v) {
    require(v.kind==V::Number&&!v.raw.empty(),"INVALID_JSON: expected unsigned integer token");
    for(char c:v.raw)require(c>='0'&&c<='9',"INVALID_JSON: expected unsigned integer token");
    std::uint32_t value=0;const auto parsed=std::from_chars(v.raw.data(),v.raw.data()+v.raw.size(),value);
    require(parsed.ec==std::errc{}&&parsed.ptr==v.raw.data()+v.raw.size(),"INVALID_JSON: integer overflow");return value;
}
const std::vector<V>& array(const V& v) { require(v.kind==V::Array,"INVALID_JSON: expected array"); return v.array; }
std::string pointer(const std::string& base,const std::string& key) {
    std::string escaped;
    for (char c:key) { if (c=='~') escaped+="~0"; else if (c=='/') escaped+="~1"; else escaped+=c; }
    return base+"/"+escaped;
}
void unknown(ProjectDocument& d,const V& v,const std::string& path,std::initializer_list<const char*> known) {
    require(v.kind==V::Object,"INVALID_JSON: expected object");
    std::set<std::string> names; for (auto k:known) names.insert(k);
    for (const auto& [key,value]:v.object) if (!names.count(key)) throw std::invalid_argument("UNSUPPORTED_FIELD: "+pointer(path,key));
}
std::uint32_t color(const V& v) {
    auto text=str(v);if(!text.empty()&&text.back()=='\n')text.pop_back();
    require(std::regex_match(text,std::regex("^#[0-9a-fA-F]{6}$")),"INVALID_JSON: invalid RGB color");
    return static_cast<std::uint32_t>(std::stoul(text.substr(1),nullptr,16));
}
V colorValue(std::uint32_t value) {
    std::ostringstream text;text<<'#'<<std::hex<<std::setw(6)<<std::setfill('0')<<value;return V::str(text.str());
}
ObjectRef ref(const V& v,ProjectDocument& d,const std::string& path) {
    ObjectRef r{str(field(v,"domain")),str(field(v,"id"))};
    const std::set<std::string> domains={"territorial","distributionLayer","distributionEntry","label","hydro","generic"};
    require(domains.count(r.domain),"INVALID_JSON: invalid ObjectRef domain");
    unknown(d,v,path,{"domain","id"}); return r;
}
V refValue(const ObjectRef& r) { return object({{"domain",V::str(r.domain)},{"id",V::str(r.id)}}); }
GeometryRef geometryRef(const V& v,ProjectDocument& d,const std::string& path) {
    GeometryRef r{str(field(v,"id")),integer(field(v,"version"))};
    unknown(d,v,path,{"id","version"}); return r;
}
V geometryRefValue(const GeometryRef& r) { return object({{"id",V::str(r.id)},{"version",V::num(r.version)}}); }
std::optional<std::string> endpoint(const V& v,ProjectDocument& d,const std::string& path) {
    if (v.kind==V::Null) return {};
    auto text=str(field(v,"text")); auto temporal=parseTemporal(text);
    require(str(field(v,"precision"))==temporal.precision,"INVALID_DATE: precision does not match text");
    unknown(d,v,path,{"text","precision"}); return text;
}
Validity validity(const V& v,ProjectDocument& d,const std::string& path) {
    Validity r{endpoint(field(v,"from"),d,path+"/from"),endpoint(field(v,"to"),d,path+"/to")};
    unknown(d,v,path,{"from","to"}); temporalBounds(r); return r;
}
LibraryOrigin libraryOrigin(const V& v,ProjectDocument& d,const std::string& path) {
    LibraryOrigin origin;
    origin.libraryId=str(field(v,"libraryId"));
    origin.geometryVersionId=str(field(v,"geometryVersionId"));
    const auto& date=field(v,"referenceDate");
    if(date.kind!=V::Null)origin.referenceDate=str(date);
    origin.sourceId=str(field(v,"sourceId"));
    origin.sourceVersion=str(field(v,"sourceVersion"));
    origin.certainty=str(field(v,"certainty"));
    origin.partial=boolean(field(v,"partial"));
    for(const auto& ref:array(field(v,"missingLibraryRefs")))
        origin.missingLibraryRefs.push_back(str(ref));
    unknown(d,v,path,
            {"libraryId","geometryVersionId","referenceDate","sourceId","sourceVersion",
             "certainty","partial","missingLibraryRefs"});
    return origin;
}
Point point(const V& v) {
    const auto& a=array(v); require(a.size()==2,"INVALID_GEOMETRY: expected two coordinates");
    return {number(a[0]),number(a[1])};
}
Ring line(const V& v) { Ring r; for (const auto& p:array(v)) r.push_back(point(p)); return r; }
Polygon polygon(const V& v) { Polygon p; for (const auto& r:array(v)) p.push_back(line(r)); return p; }
Geometry geometry(const V& v,ProjectDocument& d,const std::string& path) {
    Geometry g; g.type=str(field(v,"type")); const auto& c=field(v,"coordinates");
    if (g.type=="Point") g.points.push_back(point(c));
    else if (g.type=="MultiPoint") g.points=line(c);
    else if (g.type=="LineString") g.lines.push_back(line(c));
    else if (g.type=="MultiLineString") for (const auto& l:array(c)) g.lines.push_back(line(l));
    else if (g.type=="Polygon") g.polygons.push_back(polygon(c));
    else if (g.type=="MultiPolygon") for (const auto& p:array(c)) g.polygons.push_back(polygon(p));
    else require(false,"INVALID_GEOMETRY: unsupported GeoJSON kind");
    unknown(d,v,path,{"type","coordinates"}); return g;
}
V pointValue(Point p) { V v=V::arr(); v.array={V::num(p.x),V::num(p.y)}; return v; }
V lineValue(const Ring& l) { V v=V::arr(); for (auto p:l) v.array.push_back(pointValue(p)); return v; }
V polygonValue(const Polygon& p) { V v=V::arr(); for (const auto& l:p) v.array.push_back(lineValue(l)); return v; }
V geometryValue(const Geometry& g) {
    V c=V::arr();
    if (g.type=="Point") { require(g.points.size()==1,"INVALID_GEOMETRY: Point"); c=pointValue(g.points[0]); }
    else if (g.type=="MultiPoint") c=lineValue(g.points);
    else if (g.type=="LineString") { require(g.lines.size()==1,"INVALID_GEOMETRY: LineString"); c=lineValue(g.lines[0]); }
    else if (g.type=="MultiLineString") for (const auto& l:g.lines) c.array.push_back(lineValue(l));
    else if (g.type=="Polygon") { require(g.polygons.size()==1,"INVALID_GEOMETRY: Polygon"); c=polygonValue(g.polygons[0]); }
    else if (g.type=="MultiPolygon") for (const auto& p:g.polygons) c.array.push_back(polygonValue(p));
    else require(false,"INVALID_GEOMETRY: unsupported GeoJSON kind");
    return object({{"type",V::str(g.type)},{"coordinates",c}});
}
bool hasUnpromotedInlineAllocations(const GeometryProvenance& provenance) {
    return std::any_of(provenance.inlineAllocations.begin(),provenance.inlineAllocations.end(),
                       [](const auto& entry){return !entry.second.promoted;});
}
std::string opaqueSha256(const std::string& payload) {
    // Lossless parsing orders object keys but preserves scalar tokens and arrays.
    return sha256Bytes(codecjson::parse(payload).encode());
}
void validateProvenanceDigests(const ProjectDocument& d,bool wireIds) {
    static const std::regex digest("^[0-9a-f]{64}$");
    for(const auto& [ref,allocation]:d.geometryProvenance.inlineAllocations) {
        // Ledger creators must be exact UUIDs. The inherited web matcher uses
        // '$', which also matches before a terminal LF; do not broaden that
        // separate web compatibility boundary while validating native evidence.
        require(!wireIds||(allocation.createdFor.id.size()==36&&webObjectId(allocation.createdFor.id)),
                "INVALID_GEOMETRY_PROVENANCE: invalid creator UUID");
        require(std::regex_match(allocation.geometrySha256,digest),
                "INVALID_GEOMETRY_PROVENANCE: invalid geometry hash");
        const auto shape=d.geometries.get(ref);
        require(shape&&sha256Bytes(geometryValue(*shape).encode())==allocation.geometrySha256,
                "INVALID_GEOMETRY_PROVENANCE: geometry hash mismatch");
    }
    for(const auto& [path,hash]:d.geometryProvenance.opaqueBaseline)
        require(std::regex_match(hash,digest),
                "INVALID_GEOMETRY_PROVENANCE: invalid opaque hash");
    if(d.geometryProvenance.opaqueUncertain||!hasUnpromotedInlineAllocations(d.geometryProvenance))return;
    for(const auto& [path,value]:geometryProvenanceOpaqueSlots(d)) {
        const auto baseline=d.geometryProvenance.opaqueBaseline.find(path);
        require(baseline!=d.geometryProvenance.opaqueBaseline.end()&&baseline->second==opaqueSha256(value),
                "INVALID_GEOMETRY_PROVENANCE: opaque baseline mismatch");
    }
}
Validity recordInterval(const V& v,bool timelineOwned=false) {
    // Preserve endpoint spelling/precision. Timeline normalization owns date
    // validation and TIMELINE_INTERVAL; other content retains its wire checks.
    const auto endpoint=[timelineOwned](const V& value)->std::optional<std::string>{if(value.kind==V::Null)return {};const auto text=str(value);if(!timelineOwned)(void)parseTemporal(text);return text;};
    return {endpoint(field(v,"validFrom")),endpoint(field(v,"validTo"))};
}
TimelineRecords timelineRecords(const V& value,ProjectDocument& d) {
    TimelineRecords result;result.schemaVersion=integer(field(value,"schemaVersion"));
    unknown(d,value,"/timelineRecords",{"schemaVersion","lifetimes","geometryBindings","parentRelations","propertyBindings"});
    for(const auto& row:array(field(value,"lifetimes"))){unknown(d,row,"/timelineRecords/lifetimes",{"id","objectRef","validFrom","validTo"});result.lifetimes.push_back({str(field(row,"id")),ref(field(row,"objectRef"),d,"/timelineRecords/objectRef"),recordInterval(row,true)});}
    for(const auto& row:array(field(value,"geometryBindings"))){unknown(d,row,"/timelineRecords/geometryBindings",{"id","objectRef","validFrom","validTo","geometryRef","rendering"});result.geometryBindings.push_back({str(field(row,"id")),ref(field(row,"objectRef"),d,"/timelineRecords/objectRef"),recordInterval(row,true),geometryRef(field(row,"geometryRef"),d,"/timelineRecords/geometryBindings/geometryRef"),row.object.count("rendering")?field(row,"rendering").encode():"{}"});}
    for(const auto& row:array(field(value,"parentRelations"))){unknown(d,row,"/timelineRecords/parentRelations",{"id","objectRef","validFrom","validTo","parentId","coverageMode"});result.parentRelations.push_back({str(field(row,"id")),ref(field(row,"objectRef"),d,"/timelineRecords/objectRef"),recordInterval(row,true),str(field(row,"parentId")),str(field(row,"coverageMode"))});}
    for(const auto& row:array(field(value,"propertyBindings"))) {
        unknown(d,row,"/timelineRecords/propertyBindings",{"id","objectRef","validFrom","validTo","property","value"});
        result.propertyBindings.push_back({str(field(row,"id")),ref(field(row,"objectRef"),d,"/timelineRecords/objectRef"),recordInterval(row,true),str(field(row,"property")),field(row,"value").encode()});
    }
    return result;
}
void restoreArchive(const V& root,ProjectDocument& d,bool builtinSource) {
    TimelineStorageSnapshot candidate;candidate.records=timelineRecords(field(root,"timelineRecords"),d);
    const bool resources=root.object.count("geometryResources");
    require(!resources||builtinSource,"INVALID_GEOMETRY_RESOURCE: catalogs belong to builtin sources only");
    if(resources)for(const auto& row:array(field(root,"geometryResources"))) {
        require(row.object.size()==5,"INVALID_GEOMETRY_RESOURCE: descriptor fields");
        GeometryRef ref{str(field(row,"id")),integer(field(row,"version"))};
        GeometryResource resource{str(field(row,"type")),str(field(row,"contentSha256")),integer(field(row,"decodedBytes"))};
        require(candidate.resources.emplace(std::move(ref),std::move(resource)).second,"DUPLICATE_ID: geometry resource");
    }
    for(const auto& row:array(field(root,"geometries"))){
        const GeometryRef ref{str(field(row,"id")),integer(field(row,"version"))};
        Geometry shape;
        if(resources){require(row.object.size()==3&&candidate.resources.count(ref),"INVALID_GEOMETRY_RESOURCE: payload owner");shape=decodeGeometryResource(candidate.resources.at(ref),str(field(row,"source")));}
        else {unknown(d,row,"/geometries",{"id","version","geojson"});shape=geometry(field(row,"geojson"),d,"/geometries/geojson");}
        candidate.geometries.push_back({ref,std::make_shared<const Geometry>(std::move(shape))});
    }
    auto restored=restoreTimelineStorage(candidate,timelineEntityCatalog(d));d.timelineRecords=std::move(restored.records);d.geometries=std::move(restored.geometries);
}
V jsonObject(const std::string& bytes) {
    auto v=codecjson::parse(bytes);
    require(v.kind==V::Object,"INVALID_CONTENT: expected JSON object"); return v;
}
V webAnnotation(const std::string& bytes) {
    auto value=codecjson::parse(bytes);
    require(value.kind==V::Object||value.kind==V::Array,"INVALID_CONTENT: expected JSON object or array");return value;
}
void readPresentation(const V& value,ProjectDocument& d) {
    const auto& p=value;
    const auto& styles=field(p,"objectStyles"); require(styles.kind==V::Object,"INVALID_JSON: objectStyles");
    for (const auto& [domain,items]:styles.object) {
        auto path=pointer("/presentation/objectStyles",domain);
        require(std::set<std::string>{"territorial","label","hydro","generic","distributionEntry"}.count(domain),"INVALID_STYLE_DOMAIN");
        require(items.kind==V::Object,"INVALID_JSON: domain styles");
        for (const auto& [id,v]:items.object) {
            const bool automatic=field(v,"color").kind==V::Null;
            d.presentation.objectStyles.emplace(ObjectRef{domain,id},ObjectStyle{automatic?0:color(field(v,"color")),!automatic});
            unknown(d,v,pointer(path,id),{"color"});
        }
    }
    const auto& w=field(p,"webPresentation");auto& out=d.presentation.webPresentation;
    for(const auto* key:{"visibility","hiddenItems"})require(!w.object.count(key),"PL-SCHEMA-FIELD: viewing state is device-only");
    auto readStyles=[&](const char* name,auto& target){
        const auto& values=field(w,name);require(values.kind==V::Object,"INVALID_JSON: presentation styles");
        for(const auto& [key,value]:values.object){
            const bool supported=std::string(name)=="styles"?(presentationGroup(key)):key.rfind("territorial:entity:",0)==0;
            require(supported,"UNSUPPORTED_PRESENTATION_KEY");
            PresentationStyle s;require(value.kind==V::Object,"INVALID_JSON: presentation style");
            if(value.object.count("boundaryVisible"))s.boundaryVisible=boolean(field(value,"boundaryVisible"));
            if(value.object.count("colorVisible"))s.colorVisible=boolean(field(value,"colorVisible"));
            if(value.object.count("labelsVisible"))s.labelsVisible=boolean(field(value,"labelsVisible"));
            if(value.object.count("boundaryWidth"))s.boundaryWidth=number(field(value,"boundaryWidth"));
            if(value.object.count("blendMode"))s.blendMode=str(field(value,"blendMode"));
            target[key]=s;unknown(d,value,pointer(std::string("/presentation/webPresentation/")+name,key),{"colorVisible","boundaryVisible","labelsVisible","boundaryWidth","blendMode"});
        }
    };
    readStyles("styles",out.styles);readStyles("objectStyles",out.objectStyles);
    std::set<std::string> overlays;
    out.overlayOrderPresent=w.object.count("overlayOrder");
    if(out.overlayOrderPresent)for(const auto& key:array(field(w,"overlayOrder"))){const auto text=str(key);require((text=="genericFeatures"||text=="distributions"||text=="objects")&&overlays.insert(text).second,"UNSUPPORTED_OVERLAY_ORDER");out.overlayOrder.push_back(text);}
    for(const auto& key:array(field(w,"objectOrder"))){const auto text=str(key);require(text.rfind("territorial:entity:",0)==0,"INVALID_PRESENTATION_ORDER");out.objectOrder.push_back(text);}
    if(w.object.count("labelSettings")) for(const auto& value:array(field(w,"labelSettings"))) {
        auto path="/presentation/webPresentation/labelSettings/"+std::to_string(out.labelSettings.size());
        const auto owner=ref(field(value,"ref"),d,path+"/ref");LabelSettings s;
        if(value.object.count("priority"))s.priority=number(field(value,"priority"));
        if(value.object.count("minZoom"))s.minZoom=number(field(value,"minZoom"));
        if(value.object.count("maxZoom"))s.maxZoom=number(field(value,"maxZoom"));
        if(value.object.count("manualPosition")){const auto& a=array(field(value,"manualPosition"));require(a.size()==2,"INVALID_LABEL_SETTINGS");s.manualPosition=Point{number(a[0]),number(a[1])};}
        s.pinned=value.object.count("pinned")&&boolean(field(value,"pinned"));
        if(value.object.count("collisionGroup"))s.collisionGroup=str(field(value,"collisionGroup"));
        require(out.labelSettings.emplace(owner,std::move(s)).second,"DUPLICATE_ID: label settings");
        unknown(d,value,path,{"ref","priority","minZoom","maxZoom","manualPosition","pinned","collisionGroup"});
    }
    if(w.object.count("distributionSettings")) {
        const auto& value=field(w,"distributionSettings");const auto mode=str(field(value,"renderMode"));
        require(mode=="overlap"||mode=="single","INVALID_DISTRIBUTION_SETTINGS");
        out.distributionSettings.renderMode=mode=="single"?DistributionRenderMode::Single:DistributionRenderMode::Overlap;
        out.distributionSettings.activeLayerId=str(field(value,"activeLayerId"));
        out.distributionSettings.boundaryVisible=boolean(field(value,"boundaryVisible"));
        unknown(d,value,"/presentation/webPresentation/distributionSettings",{"renderMode","activeLayerId","boundaryVisible"});
    }
    unknown(d,w,"/presentation/webPresentation",{"styles","objectStyles","objectOrder","overlayOrder","labelSettings","distributionSettings"});
    unknown(d,p,"/presentation",{"objectStyles","webPresentation"});

}


}

codecjson::Value validateProjectSetup(const V& setup) {
    require(setup.kind==V::Object&&setup.object.size()==4,"PROJECT_SETUP: four settings required");
    const auto month=parseTemporal(str(field(setup,"initialMonth")));require(month.precision=="month","PROJECT_SETUP: month required");
    const auto& range=field(setup,"timelineRange");
    if(range.kind!=V::Null){require(range.kind==V::Object&&range.object.size()==2,"PROJECT_SETUP: invalid range");
        const auto start=parseTemporal(str(field(range,"start"))),end=parseTemporal(str(field(range,"end")));
        require(start.precision=="month"&&end.precision=="month"&&!(end.startKey<start.startKey),"PROJECT_SETUP: reversed range");
        require(!(month.startKey<start.startKey)&&!(end.startKey<month.startKey),"PROJECT_SETUP: initial month outside range");}
    const auto& bounds=field(setup,"initialMapBounds");
    if(bounds.kind!=V::Null){require(bounds.kind==V::Object&&bounds.object.size()==4,"PROJECT_SETUP: invalid bounds");
        const auto west=number(field(bounds,"west")),east=number(field(bounds,"east")),south=number(field(bounds,"south")),north=number(field(bounds,"north"));
        require(west>=-180&&west<=180&&east>=-180&&east<=180&&west!=east&&south>=-90&&north<=90&&south<north,"PROJECT_SETUP: invalid bounds");}
    const auto mode=str(field(setup,"sourceMode"));require(mode=="builtin"||mode=="empty","PROJECT_SETUP: invalid source mode");
    auto result=setup;result.object["initialMonth"]=V::str(month.canonical);return result;
}
void requireNavigationMonth(const V& setup,const std::string& month) {
    const auto point=parseTemporal(month);const auto& range=field(setup,"timelineRange");if(range.kind==V::Null)return;
    require(!(point.startKey<parseTemporal(str(field(range,"start"))).startKey)&&!(parseTemporal(str(field(range,"end"))).startKey<point.startKey),"PROJECT_RANGE: selected month is outside the navigation range");
}
std::string restoredTimelineMonth(const ProjectDocument& document) {
    const auto header=codecjson::parse(document.exchangeMetadata);
    const auto setup=validateProjectSetup(field(header,"projectSetup"));
    return str(field(setup,"initialMonth"));
}
namespace codec_detail {
std::string optionalText(const V& v,const std::string& key,const std::string& fallback="") {
    const auto i=v.object.find(key);return i==v.object.end()||i->second.kind==V::Null?fallback:str(i->second);
}
V strings(std::initializer_list<const char*> values){V result=V::arr();for(const auto* value:values)result.array.push_back(V::str(value));return result;}
V currentWebHeader() {
    return object({{"version",V::str("0.1.0-timeline")},{"savedAt",V::str("")},{"baseDataset",V::str("external-territorial-entities")},{"sourceInfo",V{}},{"physicalSourceInfo",V::obj()},{"mapProjectIdentity",V{}},{"projectSetup",codecjson::parse(ProjectDocument{}.exchangeMetadata).object.at("projectSetup")},
        {"landObjectModel",object({{"schemaVersion",V::num(2)},{"coastlineAuthority",V::str("territorialEntities")},{"purpose",V::str("lossless-fallback")},{"directCreation",V::boolean(false)},{"sourceProvenanceSchemaVersion",V::num(1)},{"canonicalProperties",strings({"name","notes","color","locked","source"})}})},
        {"territorialModel",object({{"schemaVersion",V::num(TerritorialIdentityVersion)},{"coastlineAuthority",V::str("territorialEntities")},{"storage",V::str("territorialEntities")},{"kinds",strings({"general","regional"})},{"coverageModes",strings({"partition","explicit"})}})},
        {"distributionModel",object({{"schemaVersion",V::num(3)},{"sourceModes",strings({"territorial","geometry"})},{"valueKind",V::str("finite-number")}})}});
}
void validateHeader(const V& header,const ProjectDocument&) {
    const auto contracts=currentWebHeader();
    for(const auto* key:{"landObjectModel","territorialModel","distributionModel"})require(field(header,key).encode()==field(contracts,key).encode(),"UNSUPPORTED_MODEL_CONTRACT");
    for(const auto* key:{"version","savedAt","baseDataset"})(void)str(field(header,key));
    require(field(header,"sourceInfo").kind==V::Null||field(header,"sourceInfo").kind==V::Object,"INVALID_SOURCE_INFO");
    require(field(header,"physicalSourceInfo").kind==V::Object,"INVALID_PHYSICAL_SETTINGS");
    const auto& identity=field(header,"mapProjectIdentity");
    if(identity.kind!=V::Null) {
        require(identity.kind==V::Object&&identity.object.size()==3,
                "INVALID_MAP_PROJECT_IDENTITY: expected three fields");
        const auto id=str(field(identity,"projectId"));
        require(!id.empty()&&id.size()<=64&&id[0]>='a'&&id[0]<='z'&&
                id.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789-")==std::string::npos,
                "INVALID_MAP_PROJECT_IDENTITY: project ID");
        const auto digest=str(field(identity,"manifestSha256"));
        require(digest.size()==64&&digest.find_first_not_of("0123456789abcdef")==std::string::npos,
                "INVALID_MAP_PROJECT_IDENTITY: manifest digest");
        const auto revision=str(field(identity,"dataRevision"));
        require(revision.size()==37&&revision.compare(0,5,"data-")==0&&
                revision.substr(5).find_first_not_of("0123456789abcdef")==std::string::npos,
                "INVALID_MAP_PROJECT_IDENTITY: data revision");
    }
    ProjectDocument checks;unknown(checks,header,"/exchangeMetadata",{"version","savedAt","baseDataset","sourceInfo","physicalSourceInfo","mapProjectIdentity","landObjectModel","territorialModel","distributionModel","projectSetup"});
    validateProjectSetup(field(header,"projectSetup"));
}
void validateExchangeMetadata(const ProjectDocument& d) {
    auto header=currentWebHeader();for(const auto& [key,value]:jsonObject(d.exchangeMetadata).object)header.object[key]=value;validateHeader(header,d);
}
SourceProvenance webSource(const V& value,ProjectDocument& d) {
    unknown(d,value,"/source",{"schemaVersion","kind","dataset","version","sourceId","sourceFormat","sourceType","importedAt","details"});
    require(integer(field(value,"schemaVersion"))==1,"UNSUPPORTED_SOURCE_VERSION");
    SourceProvenance result;result.kind=str(field(value,"kind"));
    result.dataset=optionalText(value,"dataset");result.version=optionalText(value,"version");result.sourceId=optionalText(value,"sourceId");result.sourceFormat=optionalText(value,"sourceFormat");result.sourceType=optionalText(value,"sourceType");result.importedAt=optionalText(value,"importedAt");
    if(value.object.count("details")&&field(value,"details").kind!=V::Null)result.details=jsonObject(field(value,"details").encode()).encode();return result;
}
void readWebTerritorialIdentity(const V& row,ProjectDocument& d,const PlatformPorts& ports) {
        unknown(d,row,"/territorialEntities",{"id","type","properties","geometry"});require(str(field(row,"type"))=="Feature"&&field(row,"geometry").kind==V::Null,"INVALID_TERRITORIAL_FEATURE");
        const auto& p=field(row,"properties");unknown(d,p,"/territorialEntities/properties",{"schemaVersion","entityKind","name","notes","style","locked","metadata","sourceFolderId","sourceEntityId","sourceGeometryVersion"});require(integer(field(p,"schemaVersion"))==TerritorialIdentityVersion,"UNSUPPORTED_ENTITY_VERSION");
        TerritorialUnit u;u.id=str(field(row,"id"));const auto kind=str(field(p,"entityKind"));require(kind=="general"||kind=="regional","INVALID_ENTITY_KIND");u.kind=kind=="general"?UnitKind::General:UnitKind::Regional;u.name=str(field(p,"name"));u.notes=str(field(p,"notes"));u.locked=boolean(field(p,"locked"));
        u.sourceFolderId=str(field(p,"sourceFolderId"));u.sourceEntityId=str(field(p,"sourceEntityId"));u.sourceGeometryVersion=str(field(p,"sourceGeometryVersion"));
        auto metadata=jsonObject(field(p,"metadata").encode());for(const auto* key:{"sovereignId","sovereign","sovereignty","politicalRelations"})require(!metadata.object.count(key),"UNSUPPORTED_POLITICAL_RELATION");const auto owner=territorialRef(u.id);
        if(metadata.object.count("capital")){const auto& capital=field(metadata,"capital");if(capital.kind==V::String||!ports.preserveWebAnnotations){d.countryDetails[owner]={str(capital)};metadata.object.erase("capital");}}
        if(metadata.object.count("flagDataUrl")) {
            const auto& flag=field(metadata,"flagDataUrl");
            const bool opaque=ports.preserveWebAnnotations&&flag.kind!=V::Null
                &&(flag.kind!=V::String||trimWebText(flag.string).empty());
            if(!opaque) {
                if(flag.kind!=V::Null)validateEmbeddedFlag(str(flag),ports);
                d.symbols[owner]={flag.kind==V::Null?FlagPolicy::None:FlagPolicy::Embedded,flag.kind==V::Null?"":str(flag)};
                metadata.object.erase("flagDataUrl");
            }
        }
        if(metadata.object.count("nameSource")){const auto& state=field(metadata,"nameSource");unknown(d,state,"/metadata/nameSource",{"baseName","nameExplicit"});u.baseName=str(field(state,"baseName"));u.nameExplicit=boolean(field(state,"nameExplicit"));metadata.object.erase("nameSource");}
        if(metadata.object.count("libraryOrigin")){u.libraryOrigin=libraryOrigin(field(metadata,"libraryOrigin"),d,"/metadata/libraryOrigin");metadata.object.erase("libraryOrigin");}
        u.metadata=metadata.encode();const auto& style=field(p,"style");unknown(d,style,"/entity/style",{"color"});ObjectStyle nativeStyle{0,false};if(style.object.count("color")){nativeStyle.color=color(field(style,"color"));nativeStyle.explicitColor=true;}require(d.presentation.objectStyles.emplace(owner,nativeStyle).second,"DUPLICATE_ENTITY_ID");d.units.push_back(std::move(u));
}
const char* webContentGeometryDomain(const std::string& domain) {
    if(domain=="label")return "label";
    if(domain=="hydro")return "hydroEdits";
    if(domain=="generic")return "genericFeatures";
    if(domain=="distributionEntry")return "distributionEntry";
    require(domain=="distributionLayer","UNSUPPORTED_WEB_CONTENT_DOMAIN");return "";
}
using WebGeometryReader=std::function<GeometryRef(const std::string&,const std::string&,const V&)>;
ContentValue readWebContentRow(ProjectDocument& d,const ObjectRef& target,const V& row,const WebGeometryReader& readGeometry) {
    const std::string wireDomain=webContentGeometryDomain(target.domain);
    const auto id=str(field(row,"id"));require(id==target.id,"INVALID_WEB_CONTENT_ID");
    require(!trimWebText(id).empty(),"INVALID_WEB_CONTENT_ID");
    if(target.domain=="label") {
        unknown(d,row,"/labels",{"id","name","kind","notes","coordinates","territorialUnitId","source","sourcePlaceId","metadata"});
        PlaceLabel label;label.id=id;label.name=str(field(row,"name"));label.kind=str(field(row,"kind"));label.notes=optionalText(row,"notes");
        label.geometry=readGeometry(wireDomain,id,object({{"type",V::str("Point")},{"coordinates",field(row,"coordinates")}}));
        const auto parent=optionalText(row,"territorialUnitId");if(!parent.empty())label.territory=territorialRef(parent);
        if(row.object.count("source"))label.source=webSource(field(row,"source"),d);
        if(row.object.count("sourcePlaceId")&&field(row,"sourcePlaceId").kind!=V::Null)label.sourcePlaceId=str(field(row,"sourcePlaceId"));
        if(row.object.count("metadata"))label.metadata=field(row,"metadata").encode();
        label.webFields.emplace();for(const auto& [key,value]:row.object)label.webFields->insert(key);
        return label;
    }
    if(target.domain=="hydro"||target.domain=="generic") {
        unknown(d,row,"/"+wireDomain,{"type","id","properties","geometry"});require(str(field(row,"type"))=="Feature","INVALID_FEATURE");
        const auto& p=field(row,"properties");const auto geo=readGeometry(wireDomain,id,field(row,"geometry"));
        if(target.domain=="generic") {
            unknown(d,p,"/genericFeatures/properties",{"schemaVersion","name","notes","color","locked","source"});
            require(integer(field(p,"schemaVersion"))==2,"UNSUPPORTED_GENERIC_VERSION");
            GenericFeature value;value.id=id;value.name=str(field(p,"name"));value.notes=str(field(p,"notes"));value.geometry=geo;
            value.explicitColor=!str(field(p,"color")).empty();value.color=value.explicitColor?color(field(p,"color")):0x8c68d8;
            value.locked=boolean(field(p,"locked"));value.source=webSource(field(p,"source"),d);return value;
        }
        require(p.kind==V::Object&&!p.object.count("visible"),"INVALID_HYDRO_PROPERTIES");
        require(integer(field(p,"pandolab_schema_version"))==1,"UNSUPPORTED_HYDRO_VERSION");
        require(str(field(p,"pandolab_domain"))=="hydro"&&str(field(p,"pandolab_id"))==id,"INVALID_HYDRO_IDENTITY");
        HydroFeature value;value.id=id;value.name=optionalText(p,"name");value.notes=optionalText(p,"notes");value.kind=str(field(p,"category"));
        value.locked=p.object.count("locked")&&boolean(field(p,"locked"));if(p.object.count("editorColor"))value.color=color(field(p,"editorColor"));
        if(p.object.count("source"))value.source=webSource(field(p,"source"),d);
        const auto sourceId=optionalText(p,"sourceFeatureId");if(!sourceId.empty())value.sourceFeatureId=sourceId;
        value.webPropertyFields.emplace();auto annotations=p;
        for(const auto* key:{"name","notes","category","locked","editorColor","source","pandolab_schema_version","pandolab_domain","pandolab_id","sourceFeatureId"}) {
            if(p.object.count(key))value.webPropertyFields->insert(key);annotations.object.erase(key);
        }
        value.annotations=annotations.encode();return value;
    }
    if(target.domain=="distributionLayer") {
        unknown(d,row,"/distributionLayers",{"id","schemaVersion","name","unit","valueScale","color","locked","parentId","groups","validFrom","validTo","metadata"});
        require(integer(field(row,"schemaVersion"))==3,"UNSUPPORTED_DISTRIBUTION_VERSION");
        DistributionLayer value;value.id=id;value.name=str(field(row,"name"));value.unit=str(field(row,"unit"));value.explicitColor=!str(field(row,"color")).empty();
        value.color=value.explicitColor?color(field(row,"color")):0x8c68d8;value.locked=boolean(field(row,"locked"));
        const auto parent=optionalText(row,"parentId");if(!parent.empty())value.parentId=parent;
        for(const auto& group:array(field(row,"groups")))value.groups.push_back(str(group));
        value.validity=recordInterval(row);value.metadata=webAnnotation(field(row,"metadata").encode()).encode();
        const auto& scale=field(row,"valueScale");const auto mode=str(field(scale,"mode"));require(mode=="auto"||mode=="manual","INVALID_VALUE_SCALE");
        unknown(d,scale,"/valueScale",{"mode","min","max"});if(mode=="manual")value.valueScale={true,number(field(scale,"min")),number(field(scale,"max"))};return value;
    }
    unknown(d,row,"/distributionEntries",{"id","schemaVersion","layerId","mode","territorialUnitId","geometry","value","certainty","validFrom","validTo","metadata"});
    require(integer(field(row,"schemaVersion"))==3,"UNSUPPORTED_DISTRIBUTION_VERSION");
    DistributionEntry value;value.id=id;value.layerId=str(field(row,"layerId"));value.value=number(field(row,"value"));value.certainty=str(field(row,"certainty"));
    value.validity=recordInterval(row);value.metadata=webAnnotation(field(row,"metadata").encode()).encode();
    const auto mode=str(field(row,"mode"));require(mode=="territorial"||mode=="geometry","INVALID_DISTRIBUTION_MODE");
    if(mode=="territorial") {require(field(row,"geometry").kind==V::Null,"INVALID_DISTRIBUTION_GEOMETRY");value.territory=territorialRef(str(field(row,"territorialUnitId")));}
    else {require(optionalText(row,"territorialUnitId").empty(),"INVALID_DISTRIBUTION_TERRITORY");value.geometry=readGeometry(wireDomain,id,field(row,"geometry"));}
    return value;
}
GeometryRef nextInlineGeometryRef(const GeometryStore& geometries,const std::string& wireDomain,const std::string& id) {
    const std::string canonical="web-"+wireDomain+":"+id;std::uint32_t latest=0;
    for(const auto& [ref,shape]:geometries.versions())if(ref.id==canonical)latest=std::max(latest,ref.version);
    require(latest<std::numeric_limits<std::uint32_t>::max(),"GEOMETRY_VERSION_OVERFLOW");return {canonical,latest+1};
}
std::optional<GeometryRef> matchingOriginalGeometry(const ProjectDocument& d,const Geometry& shape,const std::string& encoded,std::optional<GeometryRef> preferred={}) {
    const auto& originals=d.geometryProvenance.originalArchive;
    if(preferred&&originals.count(*preferred)&&d.geometries.type(*preferred)==shape.type) {
        d.geometries.requireReady({*preferred});
        if(geometryValue(*d.geometries.get(*preferred)).encode()==encoded)return preferred;
    }
    // Preserve the original sorted identity choice. Only equal types can
    // compare equal; missing candidates of another type need no payload.
    std::vector<GeometryRef> candidates;
    for(const auto& ref:originals)if(d.geometries.type(ref)==shape.type)candidates.push_back(ref);
    d.geometries.requireReady(candidates);
    for(const auto& ref:candidates)if(geometryValue(*d.geometries.get(ref)).encode()==encoded)return ref;
    return {};
}
GeometryRef inlineShape(ProjectDocument& d,const std::string& domain,const std::string& id,std::shared_ptr<const Geometry> shape) {
    const auto encoded=geometryValue(*shape).encode();const GeometryRef canonical{"web-"+domain+":"+id,1};
    // Only incoming archive rows may be reused. Another inline owner's newly
    // synthesized allocation is not an identity carrier in the web format.
    if(const auto existing=matchingOriginalGeometry(d,*shape,encoded,canonical))return *existing;
    const auto ref=nextInlineGeometryRef(d.geometries,domain,id);
    d.geometries.retain(ref,std::move(shape));
    const auto nativeDomain=domain=="hydroEdits"?"hydro":domain=="genericFeatures"?"generic":domain;
    d.geometryProvenance.inlineAllocations.emplace(ref,InlineGeometryAllocation{{nativeDomain,id},sha256Bytes(encoded),false});
    return ref;
}
GeometryRef inlineGeometry(ProjectDocument& d,const std::string& domain,const std::string& id,const V& value) {
    return inlineShape(d,domain,id,std::make_shared<const Geometry>(geometry(value,d,"/"+domain+"/geometry")));
}
void readWebPresentation(const V& root,ProjectDocument& d,bool preserveAnnotations) {
    const auto& layer=field(root,"layerPresentation");require(integer(field(layer,"schemaVersion"))==5,"UNSUPPORTED_PRESENTATION_VERSION");
    unknown(d,layer,"/layerPresentation",{"schemaVersion","styles","objectStyles","objectOrder","overlayOrder"});
    V labels=V::arr();const auto& settings=field(root,"labelSettings");require(settings.kind==V::Object,"INVALID_LABEL_SETTINGS");
    for(const auto& [key,value]:settings.object){const auto colon=key.find(':');require(colon!=std::string::npos,"INVALID_LABEL_KEY");const auto domain=key.substr(0,colon);require(domain=="territorial"||domain=="label","UNSUPPORTED_LABEL_KEY");auto row=value;require(row.kind==V::Object,"INVALID_LABEL_SETTINGS");
        if(preserveAnnotations){static const std::set<std::string> fields={"priority","minZoom","maxZoom","manualPosition","pinned","collisionGroup"};for(auto it=row.object.begin();it!=row.object.end();)if(!fields.count(it->first))it=row.object.erase(it);else ++it;}
        row.object["ref"]=refValue({domain,key.substr(colon+1)});
        for(const auto* fieldName:{"priority","minZoom","maxZoom","manualPosition"})if(row.object.count(fieldName)&&field(row,fieldName).kind==V::Null)row.object.erase(fieldName);
        if(!row.object.count("collisionGroup"))row.object["collisionGroup"]=V::str("map");labels.array.push_back(std::move(row));}
    auto presentation=object({{"objectStyles",V::obj()},{"webPresentation",object({{"styles",field(layer,"styles")},{"objectStyles",field(layer,"objectStyles")},{"objectOrder",field(layer,"objectOrder")},{"labelSettings",labels},{"distributionSettings",field(root,"distributionSettings")}})}});
    if(layer.object.count("overlayOrder"))presentation.object["webPresentation"].object["overlayOrder"]=field(layer,"overlayOrder");
    // Entity color is already owned by the native identity's presentation row.
    const auto styles=d.presentation.objectStyles;readPresentation(presentation,d);d.presentation.objectStyles=styles;
    if(preserveAnnotations)for(const auto& [key,value]:settings.object) {
        const auto colon=key.find(':');const ObjectRef ref{key.substr(0,colon),key.substr(colon+1)};auto& setting=d.presentation.webPresentation.labelSettings.at(ref);
        setting.webFields.emplace();auto annotations=value;
        for(const auto* fieldName:{"priority","minZoom","maxZoom","manualPosition","pinned","collisionGroup"})if(value.object.count(fieldName)){setting.webFields->insert(fieldName);annotations.object.erase(fieldName);}
        setting.annotations=annotations.encode();setting.webMinZoomNull=value.object.count("minZoom")&&field(value,"minZoom").kind==V::Null;
    }

}
}

std::string geometrySha256(const Geometry& shape) { return sha256Bytes(geometryValue(shape).encode()); }
bool isWebContentId(const std::string& id) { return webObjectId(id); }
std::uint32_t readWebColor(const V& value) {return color(value);}
V webColorValue(std::uint32_t value) {return colorValue(value);}
Geometry readWebGeometry(const V& value) {ProjectDocument checks;return geometry(value,checks,"/geometry");}
WebTerritorialFeature readWebTerritorialIdentityFeature(const V& row,const PlatformPorts& ports) {
    const auto& properties=field(row,"properties");
    auto identity=row;identity.object["geometry"]=V{};
    for(const auto* key:{"parentId","coverageMode","validFrom","validTo"})identity.object["properties"].object.erase(key);
    ProjectDocument parsed;readWebTerritorialIdentity(identity,parsed,ports);
    WebTerritorialFeature result;result.identity=std::move(parsed.units.at(0));result.geometry=readWebGeometry(field(row,"geometry"));
    result.parentId=str(field(properties,"parentId"));result.coverageMode=str(field(properties,"coverageMode"));result.validity=recordInterval(properties);
    const auto ref=territorialRef(result.identity.id);result.style=parsed.presentation.objectStyles.at(ref);
    if(parsed.countryDetails.count(ref))result.countryDetails=parsed.countryDetails.at(ref);
    if(parsed.symbols.count(ref))result.symbol=parsed.symbols.at(ref);return result;
}
V normalizeWebSourceProvenance(const V& input,const std::string& defaultKind) {
    auto raw=input.kind==V::Object?input:V::obj();
    if(input.kind==V::String)raw.object["dataset"]=input;
    const auto get=[&](const char* key){const auto found=raw.object.find(key);return found==raw.object.end()?V{}:found->second;};
    const auto text=[&](const char* key){return trimWebText(webCommandString(get(key)));};
    const auto suppliedKind=get("kind");
    const bool supplied=!(suppliedKind.kind==V::Null||(suppliedKind.kind==V::String&&suppliedKind.string.empty())||
        (suppliedKind.kind==V::Bool&&suppliedKind.raw=="false")||
        (suppliedKind.kind==V::Number&&codecjson::finiteNumber(suppliedKind)==0));
    auto kind=supplied?trimWebText(webCommandString(suppliedKind)):defaultKind;
    static const std::set<std::string> kinds={"user","builtin","library","gis","legacy","plugin","unsupported"};
    if(!kinds.count(kind))kind="unsupported";
    auto details=get("details");if(details.kind!=V::Object)details=V::obj();
    static const std::set<std::string> keys={"schemaVersion","kind","dataset","sourceId","sourceFormat","sourceType","version","importedAt","details"};
    auto unmapped=V::obj();
    for(const auto& [key,value]:raw.object)if(!keys.count(key))unmapped.object[key]=value;
    if(!unmapped.object.empty()) {
        auto& target=details.object["unmappedSourceFields"];if(target.kind!=V::Object)target=V::obj();
        for(auto& [key,value]:unmapped.object)target.object[key]=std::move(value);
    }
    return object({{"schemaVersion",V::num(1)},{"kind",V::str(kind)},{"dataset",V::str(text("dataset"))},
        {"sourceId",V::str(text("sourceId"))},{"sourceFormat",V::str(text("sourceFormat"))},{"sourceType",V::str(text("sourceType"))},
        {"version",V::str(text("version"))},{"importedAt",V::str(text("importedAt"))},{"details",std::move(details)}});
}
SourceProvenance readWebSourceProvenance(const V& input,const std::string& defaultKind) {
    ProjectDocument parsing;return webSource(normalizeWebSourceProvenance(input,defaultKind),parsing);
}
namespace codec_detail {
ProjectDocument readWebDocumentValue(const V& root,const PlatformPorts& ports,bool wireIds,bool builtinSource=false) {
    require(bool(ports.validateFlagDataUrl),"CODEC_PLATFORM_REQUIRED: flag validator");
    ProjectDocument d;
    require(integer(field(root,"schemaVersion"))==ProjectVersion,"UNSUPPORTED_VERSION: expected web v14");
    const auto format=str(field(root,"format"));require(format!="pandolab-autosave-delta","BASE_DATA_REQUIRED: web delta requires its matching baseline");require(format=="pandolab-project-state"||format=="pandolab-autosave-full","UNSUPPORTED_FORMAT");
    for(const auto* key:{"defaultView","layerVisibility","itemVisibility"})require(!root.object.count(key),"PL-SCHEMA-FIELD: viewing state is device-only");
    unknown(d,root,"",{"format","schemaVersion","version","savedAt","baseDataset","landObjectModel","territorialModel","distributionModel","sourceInfo","physicalSourceInfo","documentId","territorialEntities","timelineRecords","geometries","geometryResources","labels","hydroEdits","genericFeatures","distributionLayers","distributionEntries","labelSettings","distributionSettings","layerPresentation","projectSetup","mapProjectIdentity"});
    auto header=V::obj();for(const auto& [key,value]:currentWebHeader().object){
        if(key=="mapProjectIdentity"&&!root.object.count(key))header.object[key]=V{};
        else header.object[key]=field(root,key);
    }validateHeader(header,d);d.exchangeMetadata=header.encode();
    d.documentId=str(field(root,"documentId"));require(!d.documentId.empty(),"INVALID_DOCUMENT_ID");
    for(const auto& row:array(field(root,"territorialEntities")))readWebTerritorialIdentity(row,d,ports);
    for(const auto& row:array(field(root,"hydroEdits"))) {
        auto value=readWebContentRow(d,{"hydro",str(field(row,"id"))},row,[&](const std::string&,const std::string&,const V& shape){require(shape.kind==V::Null,"INVALID_HYDRO_IDENTITY: geometry belongs to timeline");return GeometryRef{};});
        d.hydro.push_back(std::get<HydroFeature>(std::move(value)));
    }
    restoreArchive(root,d,builtinSource);
    for(const auto& property:d.timelineRecords.propertyBindings)if(property.property=="flag") {
        const auto value=codecjson::parse(property.value);
        if(value.object.at("policy").string=="embedded")ports.validateFlagDataUrl(value.object.at("embeddedDataUrl").string);
    }
    for(const auto& [ref,shape]:d.geometries.versions())d.geometryProvenance.originalArchive.insert(ref);
    for(const auto& [ref,resource]:d.geometries.resources())d.geometryProvenance.originalArchive.insert(ref);
    const WebGeometryReader readGeometry=[&](const std::string& domain,const std::string& id,const V& value){
        if(domain=="hydroEdits"){require(value.kind==V::Null,"INVALID_HYDRO_IDENTITY: stored geometry belongs to timeline");auto found=std::find_if(d.timelineRecords.geometryBindings.begin(),d.timelineRecords.geometryBindings.end(),[&](const auto& row){return row.objectRef==ObjectRef{"hydro",id};});require(found!=d.timelineRecords.geometryBindings.end(),"TIMELINE_GEOMETRY: missing water binding");return found->geometryRef;}
        return inlineGeometry(d,domain,id,value);};
    for(const auto& row:array(field(root,"labels"))) {
        if(!ports.preserveWebAnnotations)unknown(d,row,"/labels",{"id","name","kind","notes","coordinates","territorialUnitId","source","sourcePlaceId"});
        d.labels.push_back(std::get<PlaceLabel>(readWebContentRow(d,{"label",str(field(row,"id"))},row,readGeometry)));
    }
    for(const auto* domain:{"hydroEdits","genericFeatures"})for(const auto& row:array(field(root,domain))) {
        const bool generic=std::string(domain)=="genericFeatures";
        if(!generic)continue;
        if(!generic&&!ports.preserveWebAnnotations) {
            const auto& properties=field(row,"properties");
            unknown(d,properties,"/hydroEdits/properties",{"name","notes","category","locked","editorColor","source","pandolab_schema_version","pandolab_domain","pandolab_id","sourceFeatureId"});
            boolean(field(properties,"locked"));
        }
        auto content=readWebContentRow(d,{generic?"generic":"hydro",str(field(row,"id"))},row,readGeometry);
        if(generic)d.genericFeatures.push_back(std::get<GenericFeature>(std::move(content)));
        else d.hydro.push_back(std::get<HydroFeature>(std::move(content)));
    }
    for(const auto& row:array(field(root,"distributionLayers")))
        d.distributionLayers.push_back(std::get<DistributionLayer>(readWebContentRow(d,{"distributionLayer",str(field(row,"id"))},row,readGeometry)));
    for(const auto& row:array(field(root,"distributionEntries")))
        d.distributionEntries.push_back(std::get<DistributionEntry>(readWebContentRow(d,{"distributionEntry",str(field(row,"id"))},row,readGeometry)));
    readWebPresentation(root,d,ports.preserveWebAnnotations);if(wireIds)validateWebObjectIds(d);
    for(const auto& [path,value]:geometryProvenanceOpaqueSlots(d))d.geometryProvenance.opaqueBaseline.emplace(path,opaqueSha256(value));
    // A newly created ledger must be saveable before this candidate can activate.
    validateProvenanceDigests(d,wireIds);
    GeometryProvenanceCodecAccess::sealVerifiedOpaqueBaseline(d);
    validateDocument(d);return d;
}
}
codecjson::Value normalizeWebTerritorialStoredIdentity(const V& input) {
    require(input.kind==V::Object&&str(field(input,"type"))=="Feature"&&!str(field(input,"id")).empty()&&field(input,"geometry").kind==V::Null,"PL-SCHEMA-FIELD: identity requires a string ID and null geometry");
    for(const auto& [key,value]:input.object)require(key=="type"||key=="id"||key=="geometry"||key=="properties","PL-SCHEMA-FIELD: unsupported identity field");
    const auto& p=field(input,"properties");require(p.kind==V::Object&&integer(field(p,"schemaVersion"))==6,"PL-SCHEMA-FIELD: identity schemaVersion");
    const auto kind=str(field(p,"entityKind"));require(kind=="general"||kind=="regional","PL-SCHEMA-FIELD: identity kind");
    const std::set<std::string> names={"schemaVersion","entityKind","name","style","locked","notes","metadata","sourceFolderId","sourceEntityId","sourceGeometryVersion"};
    for(const auto& [key,value]:p.object)require(names.count(key),"PL-SCHEMA-FIELD: unsupported identity property");
    auto props=object({{"schemaVersion",V::num(6)},{"entityKind",V::str(kind)}});
    for(const auto* key:{"name","notes","sourceFolderId","sourceEntityId","sourceGeometryVersion"}) {
        const auto found=p.object.find(key);props.object[key]=V::str(found==p.object.end()?"":trimWebText(str(found->second)));
    }
    for(const auto* key:{"style","metadata"}) {
        const auto found=p.object.find(key);require(found==p.object.end()||found->second.kind==V::Object,"PL-SCHEMA-FIELD: identity annotation object");
        props.object[key]=found==p.object.end()?V::obj():found->second;
    }
    props.object["locked"]=V::boolean(p.object.count("locked")&&boolean(field(p,"locked")));
    return object({{"type",V::str("Feature")},{"id",field(input,"id")},{"geometry",V{}},{"properties",std::move(props)}});
}
ProjectDocument decodeWebValue(const V& root,const PlatformPorts& ports){return readWebDocumentValue(root,ports,true);}
ProjectDocument decodeBuiltinSourceValue(const V& root,const PlatformPorts& ports){return readWebDocumentValue(root,ports,true,true);}
Geometry decodeGeometryResource(const GeometryResource& resource,const std::string& source) {
    require(source.size()==resource.decodedBytes&&sha256Bytes(source)==resource.contentSha256,"INVALID_GEOMETRY_RESOURCE: content integrity");
    ProjectDocument owner;auto shape=geometry(codecjson::parse(source),owner,"/geometryResource");
    require(shape.type==resource.type,"INVALID_GEOMETRY_RESOURCE: type mismatch");return shape;
}
ProjectDocument decodeWeb(const std::string& bytes,const PlatformPorts& ports){return readWebDocumentValue(codecjson::parse(bytes,ports.parsedTextPolicy),ports,true);}
ProjectDocument readWebSnapshot(const std::string& bytes,const PlatformPorts& ports){return readWebDocumentValue(codecjson::parse(bytes,ports.parsedTextPolicy),ports,false);}

ProjectDocument replaceWebTerritorialSource(const ProjectDocument& content,const ProjectDocument& source,const std::string& month) {
    auto next=content;next.units=source.units;next.countryDetails=source.countryDetails;next.symbols=source.symbols;
    next.timelineRecords=source.timelineRecords;next.geometries=GeometryStore{};next.geometryProvenance=GeometryProvenance{};
    const auto territorialOnly=[](auto& rows){rows.erase(std::remove_if(rows.begin(),rows.end(),[](const auto& row){return row.objectRef.domain!="territorial";}),rows.end());};
    territorialOnly(next.timelineRecords.lifetimes);territorialOnly(next.timelineRecords.geometryBindings);
    territorialOnly(next.timelineRecords.parentRelations);territorialOnly(next.timelineRecords.propertyBindings);
    std::set<GeometryRef> sourceGeometryRefs;
    for(const auto& row:next.timelineRecords.geometryBindings)sourceGeometryRefs.insert(row.geometryRef);
    for(const auto& ref:sourceGeometryRefs) {
        if(const auto resource=source.geometries.resources().find(ref);resource!=source.geometries.resources().end())next.geometries.declareResource(ref,resource->second);
        if(source.geometries.get(ref))next.geometries.retainFrom(source.geometries,ref,ref);
        else require(next.geometries.contains(ref),"DANGLING_REF: source admission geometry");
        next.geometryProvenance.originalArchive.insert(ref);
    }
    next.presentation.objectStyles=source.presentation.objectStyles;
    const auto bind=[&](const char* domain,const std::string& id,const GeometryRef& ref) {
        const auto shape=content.geometries.get(ref);require(bool(shape),"DANGLING_REF: source admission content geometry");
        return inlineShape(next,domain,id,shape);
    };
    for(auto& row:next.labels)row.geometry=bind("label",row.id,row.geometry);
    for(const auto& row:content.timelineRecords.lifetimes)if(row.objectRef.domain=="hydro")next.timelineRecords.lifetimes.push_back(row);
    for(auto row:content.timelineRecords.geometryBindings)if(row.objectRef.domain=="hydro"){
        if(!next.geometries.get(row.geometryRef))next.geometries.retainFrom(content.geometries,row.geometryRef,row.geometryRef);
        next.geometryProvenance.originalArchive.insert(row.geometryRef);next.timelineRecords.geometryBindings.push_back(row);
    }
    for(const auto& row:content.timelineRecords.propertyBindings)if(row.objectRef.domain=="hydro")next.timelineRecords.propertyBindings.push_back(row);
    for(auto& row:next.genericFeatures)row.geometry=bind("genericFeatures",row.id,row.geometry);
    for(auto& row:next.distributionEntries)if(row.geometry)row.geometry=bind("distributionEntry",row.id,*row.geometry);
    normalizePresentation(next,month);
    for(const auto& [path,value]:geometryProvenanceOpaqueSlots(next))next.geometryProvenance.opaqueBaseline.emplace(path,opaqueSha256(value));
    validateProvenanceDigests(next,false);GeometryProvenanceCodecAccess::sealVerifiedOpaqueBaseline(next);validateDocument(next);return next;
}
}
