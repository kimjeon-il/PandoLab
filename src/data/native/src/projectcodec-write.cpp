#include "projectcodec-detail.h"
#include <pandoeditor/timeline-storage.h>
#include <pandoeditor/timeline-resolver.h>
#include <pandoeditor/geometryprovenance.h>
#include <pandoeditor/objectproperties.h>
#include <pandoeditor/webcommands.h>
#include <algorithm>
#include <cctype>
#include <cmath>
#include <set>
#include <stdexcept>
#include <type_traits>

namespace pandoeditor::projectcodec {
using namespace codec_detail;
namespace {
V libraryOriginValue(const LibraryOrigin& origin) {
    V missing=V::arr();
    for(const auto& ref:origin.missingLibraryRefs)missing.array.push_back(V::str(ref));
    return object({{"libraryId",V::str(origin.libraryId)},
                   {"geometryVersionId",V::str(origin.geometryVersionId)},
                   {"referenceDate",origin.referenceDate?V::str(*origin.referenceDate):V{}},
                   {"sourceId",V::str(origin.sourceId)},{"sourceVersion",V::str(origin.sourceVersion)},
                   {"certainty",V::str(origin.certainty)},
                   {"partial",V::boolean(origin.partial)},{"missingLibraryRefs",missing}});
}

V geometryProvenanceValue(const GeometryProvenance& provenance) {
    V originals=V::arr(),allocations=V::arr(),opaque=V::arr();
    for(const auto& ref:provenance.originalArchive)originals.array.push_back(geometryRefValue(ref));
    for(const auto& [ref,allocation]:provenance.inlineAllocations)
        allocations.array.push_back(object({{"ref",geometryRefValue(ref)},{"createdFor",refValue(allocation.createdFor)},
            {"geometrySha256",V::str(allocation.geometrySha256)},{"promoted",V::boolean(allocation.promoted)}}));
    for(const auto& [path,hash]:provenance.opaqueBaseline)
        opaque.array.push_back(object({{"path",V::str(path)},{"sha256",V::str(hash)}}));
    return object({{"schemaVersion",V::num(1)},{"originalArchive",originals},{"inlineAllocations",allocations},
                   {"opaqueBaseline",opaque},{"opaqueUncertain",V::boolean(provenance.opaqueUncertain)}});
}

V timelineRecordsValue(const TimelineRecords& records) {
    V life=V::arr(),bindings=V::arr(),parents=V::arr(),properties=V::arr();
    auto row=[](const auto& record){return object({{"id",V::str(record.id)},{"objectRef",refValue(record.objectRef)},{"validFrom",record.validity.from?V::str(*record.validity.from):V{}},{"validTo",record.validity.to?V::str(*record.validity.to):V{}}});};
    for(const auto& record:records.lifetimes)life.array.push_back(row(record));
    for(const auto& record:records.geometryBindings){auto value=row(record);value.object["geometryRef"]=geometryRefValue(record.geometryRef);if(record.rendering!="{}")value.object["rendering"]=codecjson::parse(record.rendering);bindings.array.push_back(std::move(value));}
    for(const auto& record:records.parentRelations){auto value=row(record);value.object["parentId"]=V::str(record.parentId);value.object["coverageMode"]=V::str(record.coverageMode);parents.array.push_back(std::move(value));}
    for(const auto& record:records.propertyBindings){auto value=row(record);value.object["property"]=V::str(record.property);value.object["value"]=codecjson::parse(record.value);properties.array.push_back(std::move(value));}
    return object({{"schemaVersion",V::num(records.schemaVersion)},{"lifetimes",life},{"geometryBindings",bindings},{"parentRelations",parents},{"propertyBindings",properties}});
}

std::string decimalValue(std::string token) {
    std::transform(token.begin(),token.end(),token.begin(),[](unsigned char c){return static_cast<char>(std::tolower(c));});
    const auto split=token.find('e');const auto mantissa=token.substr(0,split);
    std::int64_t exponent=0;if(split!=std::string::npos) {
        const auto value=token.substr(split+1);std::size_t end=0;
        try { exponent=std::stoll(value,&end); }catch(const std::exception&){throw std::invalid_argument("UNREPRESENTABLE_WEB_NUMBER");}
        require(end==value.size(),"UNREPRESENTABLE_WEB_NUMBER");
    }
    require(exponent>=-1000000000&&exponent<=1000000000,"UNREPRESENTABLE_WEB_NUMBER");
    auto digits=mantissa;const bool negative=!digits.empty()&&digits.front()=='-';if(negative)digits.erase(0,1);
    const auto point=digits.find('.');if(point!=std::string::npos){exponent-=digits.size()-point-1;digits.erase(point,1);}
    while(!digits.empty()&&digits.front()=='0')digits.erase(0,1);
    if(digits.empty())return negative?"-0":"0";
    while(digits.back()=='0'){digits.pop_back();++exponent;}
    return (negative?"-":"")+digits+"e"+std::to_string(exponent);
}
void requireWebNumbers(const V& value) {
    if(value.kind==V::Number) {
        double number=0;try { number=codecjson::finiteNumber(value); }catch(const std::exception&){throw std::invalid_argument("UNREPRESENTABLE_WEB_NUMBER");}
        require(decimalValue(value.raw)==decimalValue(V::num(number).raw),"UNREPRESENTABLE_WEB_NUMBER");
    }else if(value.kind==V::Array)for(const auto& child:value.array)requireWebNumbers(child);
    else if(value.kind==V::Object)for(const auto& entry:value.object)requireWebNumbers(entry.second);
}
V validatedEntityMetadata(const std::string& bytes,bool preserveOpaqueAnnotations=false) {
    auto value=jsonObject(bytes);
    for(const auto* key:{"sovereignId","sovereign","sovereignty","politicalRelations"})require(!value.object.count(key),"UNSUPPORTED_POLITICAL_RELATION");
    for(const auto* key:{"capital","flagDataUrl","nameSource","libraryOrigin"}) {
        if(preserveOpaqueAnnotations&&(std::string(key)=="capital"||std::string(key)=="flagDataUrl"))continue;
        require(!value.object.count(key),"DUPLICATE_METADATA_OWNER");
    }
    return value;
}
V sourceValue(const SourceProvenance& s) {
    return object({{"kind",V::str(s.kind)},{"dataset",V::str(s.dataset)},{"version",V::str(s.version)},
        {"sourceId",V::str(s.sourceId)},{"sourceFormat",V::str(s.sourceFormat)},{"sourceType",V::str(s.sourceType)},
        {"importedAt",V::str(s.importedAt)},{"details",jsonObject(s.details)}});
}

V webPresentationValue(const ProjectDocument& d) {
    const auto& web=d.presentation.webPresentation;
    V groups=V::obj(),overrides=V::obj(),order=V::arr(),overlayOrder=V::arr();
    auto writeStyles=[](const auto& source,V& target){for(const auto& [key,s]:source){V v=V::obj();if(s.colorVisible)v.object["colorVisible"]=V::boolean(*s.colorVisible);if(s.boundaryVisible)v.object["boundaryVisible"]=V::boolean(*s.boundaryVisible);if(s.labelsVisible)v.object["labelsVisible"]=V::boolean(*s.labelsVisible);if(s.boundaryWidth)v.object["boundaryWidth"]=V::num(*s.boundaryWidth);if(s.blendMode)v.object["blendMode"]=V::str(*s.blendMode);target.object[key]=v;}};
    writeStyles(web.styles,groups);writeStyles(web.objectStyles,overrides);for(const auto& key:web.objectOrder)order.array.push_back(V::str(key));for(const auto& key:web.overlayOrder)overlayOrder.array.push_back(V::str(key));
    auto distributionSettings=object({{"renderMode",V::str(web.distributionSettings.renderMode==DistributionRenderMode::Single?"single":"overlap")},{"activeLayerId",V::str(web.distributionSettings.activeLayerId)},{"boundaryVisible",V::boolean(web.distributionSettings.boundaryVisible)}});
    auto webValue=object({{"styles",groups},{"objectStyles",overrides},{"objectOrder",order},{"overlayOrder",overlayOrder},{"distributionSettings",distributionSettings}});
    if(!web.overlayOrderPresent)webValue.object.erase("overlayOrder");
    return webValue;
}

V webSourceValue(const SourceProvenance& value){auto result=sourceValue(value);result.object["schemaVersion"]=V::num(1);return result;}

V labelSettingsValue(const LabelSettings& settings) {
    V result=object({{"pinned",V::boolean(settings.pinned)},{"collisionGroup",V::str(settings.collisionGroup)}});
    result.object["priority"]=settings.priority?V::num(*settings.priority):V{};result.object["minZoom"]=settings.minZoom?V::num(*settings.minZoom):V::num(0);result.object["maxZoom"]=settings.maxZoom&&std::isfinite(*settings.maxZoom)?V::num(*settings.maxZoom):V{};
    result.object["manualPosition"]=settings.manualPosition?pointValue(*settings.manualPosition):V{};
    if(settings.webMinZoomNull)result.object["minZoom"]=V{};
    if(settings.webFields) {
        for(auto it=result.object.begin();it!=result.object.end();) {
            if(!settings.webFields->count(it->first))it=result.object.erase(it);else ++it;
        }
    }
    for(const auto& [key,value]:jsonObject(settings.annotations).object){require(!result.object.count(key),"DUPLICATE_LABEL_SETTINGS_OWNER");result.object[key]=value;}
    return result;
}
}

namespace {
V webIdentity(const ProjectDocument& d,const TerritorialUnit& u) {
const auto owner=territorialRef(u.id);auto metadata=validatedEntityMetadata(u.metadata,true);if(const auto details=d.countryDetails.find(owner);details!=d.countryDetails.end())metadata.object["capital"]=V::str(details->second.capital);if(const auto symbol=d.symbols.find(owner);symbol!=d.symbols.end()&&symbol->second.policy!=FlagPolicy::Default)metadata.object["flagDataUrl"]=symbol->second.policy==FlagPolicy::None?V{}:V::str(symbol->second.embeddedDataUrl);
        if(!u.baseName.empty()||!u.nameExplicit)metadata.object["nameSource"]=object({{"baseName",V::str(u.baseName)},{"nameExplicit",V::boolean(u.nameExplicit)}});if(u.libraryOrigin)metadata.object["libraryOrigin"]=libraryOriginValue(*u.libraryOrigin);
        const auto& style=d.presentation.objectStyles.at(owner);V color=V::obj();if(style.explicitColor)color.object["color"]=colorValue(style.color);
        return object({{"type",V::str("Feature")},{"id",V::str(u.id)},{"geometry",V{}},{"properties",object({{"schemaVersion",V::num(TerritorialIdentityVersion)},{"entityKind",V::str(u.kind==UnitKind::General?"general":"regional")},{"name",V::str(u.name)},{"notes",V::str(u.notes)},{"locked",V::boolean(u.locked)},{"style",color},{"metadata",metadata},{"sourceFolderId",V::str(u.sourceFolderId)},{"sourceEntityId",V::str(u.sourceEntityId)},{"sourceGeometryVersion",V::str(u.sourceGeometryVersion)}})}});
}
}
namespace {
V webLabel(const ProjectDocument& d,const PlaceLabel& label,const Geometry* supplied=nullptr) {
    const auto stored=d.geometries.get(label.geometry);const auto shape=supplied?supplied:stored.get();require(shape&&shape->type=="Point","INVALID_LABEL_GEOMETRY");
    auto row=object({{"id",V::str(label.id)},{"name",V::str(label.name)},{"kind",V::str(label.kind)},{"notes",V::str(label.notes)},
        {"coordinates",pointValue(shape->points.at(0))},{"territorialUnitId",V::str(label.territory?label.territory->id:"")},{"source",webSourceValue(label.source)}});
    if(label.sourcePlaceId)row.object["sourcePlaceId"]=V::str(*label.sourcePlaceId);
    if(label.metadata)row.object["metadata"]=codecjson::parse(*label.metadata);
    if(label.webFields)for(auto it=row.object.begin();it!=row.object.end();) {
        if(!label.webFields->count(it->first))it=row.object.erase(it);else ++it;
    }
    return row;
}
template<class Content> V webFeature(const ProjectDocument& d,const Content& value,V props,const Geometry* supplied=nullptr) {
    const auto stored=d.geometries.get(value.geometry);const auto shape=supplied?supplied:stored.get();require(shape,"INVALID_CONTENT_GEOMETRY");
    return object({{"type",V::str("Feature")},{"id",V::str(value.id)},{"geometry",geometryValue(*shape)},{"properties",props}});
}
V webGeneric(const ProjectDocument& d,const GenericFeature& value,const Geometry* supplied=nullptr) {
    require(value.fallbackOnly,"UNSUPPORTED_WEB_EXPORT: generic direct creation");
    return webFeature(d,value,object({{"schemaVersion",V::num(2)},{"name",V::str(value.name)},{"notes",V::str(value.notes)},
        {"color",value.explicitColor?colorValue(value.color):V::str("")},{"locked",V::boolean(value.locked)},{"source",webSourceValue(value.source)}}),supplied);
}
V webHydro(const ProjectDocument& d,const HydroFeature& value,const Geometry* supplied=nullptr) {
    auto props=object({{"name",V::str(value.name)},{"notes",V::str(value.notes)},{"category",V::str(value.kind)},
        {"locked",V::boolean(value.locked)},{"editorColor",colorValue(value.color)},{"source",webSourceValue(value.source)},
        {"pandolab_schema_version",V::num(1)},{"pandolab_domain",V::str("hydro")},{"pandolab_id",V::str(value.id)}});
    if(value.sourceFeatureId)props.object["sourceFeatureId"]=V::str(*value.sourceFeatureId);
    if(value.webPropertyFields)for(auto it=props.object.begin();it!=props.object.end();) {
        if(!value.webPropertyFields->count(it->first))it=props.object.erase(it);else ++it;
    }
    for(const auto& [key,item]:jsonObject(value.annotations).object) {
        require(!props.object.count(key),"DUPLICATE_HYDRO_PROPERTY_OWNER");props.object.emplace(key,item);
    }
    if constexpr(std::is_same_v<std::decay_t<decltype(value)>,HydroFeature>){
        if(!supplied)return object({{"type",V::str("Feature")},{"id",V::str(value.id)},{"geometry",V{}},{"properties",props}});
        return object({{"type",V::str("Feature")},{"id",V::str(value.id)},{"geometry",geometryValue(*supplied)},{"properties",props}});
    }else return webFeature(d,value,props,supplied);
}
template<class Content> V webInterval(const Content& value) {
    return object({{"id",V::str(value.id)},{"schemaVersion",V::num(3)},{"validFrom",value.validity.from?V::str(*value.validity.from):V{}},
        {"validTo",value.validity.to?V::str(*value.validity.to):V{}},{"metadata",webAnnotation(value.metadata)}});
}
V webDistributionLayer(const DistributionLayer& value) {
    auto row=webInterval(value);row.object["name"]=V::str(value.name);row.object["unit"]=V::str(value.unit);row.object["color"]=value.explicitColor?colorValue(value.color):V::str("");
    row.object["locked"]=V::boolean(value.locked);row.object["parentId"]=V::str(value.parentId.value_or(""));V groups=V::arr();
    for(const auto& group:value.groups)groups.array.push_back(V::str(group));row.object["groups"]=groups;
    row.object["valueScale"]=value.valueScale.manual?object({{"mode",V::str("manual")},{"min",V::num(value.valueScale.min)},{"max",V::num(value.valueScale.max)}}):object({{"mode",V::str("auto")}});return row;
}
V webDistributionEntry(const ProjectDocument& d,const DistributionEntry& value,const Geometry* supplied=nullptr) {
    auto row=webInterval(value);row.object["layerId"]=V::str(value.layerId);row.object["mode"]=V::str(value.territory?"territorial":"geometry");
    row.object["territorialUnitId"]=V::str(value.territory?value.territory->id:"");row.object["geometry"]=supplied?geometryValue(*supplied):value.geometry?geometryValue(*d.geometries.get(*value.geometry)):V{};
    row.object["value"]=V::num(value.value);row.object["certainty"]=V::str(value.certainty);return row;
}
V webPresentationFields(const ProjectDocument& d) {
    const auto presentationValues=webPresentationValue(d);auto settings=V::obj();
    auto layer=object({{"schemaVersion",V::num(5)},{"styles",field(presentationValues,"styles")},{"objectStyles",field(presentationValues,"objectStyles")},{"objectOrder",field(presentationValues,"objectOrder")}});
    if(presentationValues.object.count("overlayOrder"))layer.object["overlayOrder"]=field(presentationValues,"overlayOrder");
    for(const auto& entry:d.presentation.webPresentation.labelSettings)settings.object[entry.first.domain+":"+entry.first.id]=labelSettingsValue(entry.second);
    return object({{"layerPresentation",layer},
        {"labelSettings",settings},{"distributionSettings",field(presentationValues,"distributionSettings")}});
}
std::set<GeometryRef> semanticArchive(const ProjectDocument& d) {
    std::set<GeometryRef> result;for(const auto& entry:d.geometries.versions()) {
        const auto allocation=d.geometryProvenance.inlineAllocations.find(entry.first);
        if(allocation==d.geometryProvenance.inlineAllocations.end()||allocation->second.promoted)result.insert(entry.first);
    }
    return result;
}
template<class Rows,class Encode> std::pair<V,std::int64_t> objectAt(const Rows& rows,const std::string& id,Encode encode) {
    for(std::size_t i=0;i<rows.size();++i)if(rows[i].id==id)return {encode(rows[i]),static_cast<std::int64_t>(i)};
    return {V{},-1};
}
bool sameSource(const SourceProvenance& a,const SourceProvenance& b) {
    return std::tie(a.kind,a.dataset,a.version,a.sourceId,a.sourceFormat,a.sourceType,a.importedAt,a.details)
        ==std::tie(b.kind,b.dataset,b.version,b.sourceId,b.sourceFormat,b.sourceType,b.importedAt,b.details);
}
template<class Rows,class Equal> bool sameContentRow(const Rows& before,const Rows& after,const std::string& id,Equal equal) {
    const auto a=std::find_if(before.begin(),before.end(),[&](const auto& row){return row.id==id;});
    const auto b=std::find_if(after.begin(),after.end(),[&](const auto& row){return row.id==id;});
    return a!=before.end()&&b!=after.end()&&equal(*a,*b);
}
// Scene invalidations can include many descendants or all displayed objects.
// A data delta contains only owners whose stored Web DTO actually changed.
// Compare typed content first so unrelated inline geometry is never encoded.
bool unchangedWebObject(const ProjectDocument& before,const ProjectDocument& after,const ObjectRef& ref) {
    if(ref.domain=="territorial")return sameContentRow(before.units,after.units,ref.id,[&](const auto& a,const auto& b){
        return webIdentity(before,a).encode()==webIdentity(after,b).encode();});
    if(ref.domain=="label")return sameContentRow(before.labels,after.labels,ref.id,[](const auto& a,const auto& b){
        return std::tie(a.name,a.kind,a.notes,a.geometry,a.territory,a.sourcePlaceId,a.metadata)==std::tie(b.name,b.kind,b.notes,b.geometry,b.territory,b.sourcePlaceId,b.metadata)&&sameSource(a.source,b.source)&&labelWebFields(a)==labelWebFields(b);});
    if(ref.domain=="hydro")return sameContentRow(before.hydro,after.hydro,ref.id,[](const auto& a,const auto& b){
        return std::tie(a.name,a.kind,a.notes,a.color,a.locked,a.sourceFeatureId,a.annotations)==std::tie(b.name,b.kind,b.notes,b.color,b.locked,b.sourceFeatureId,b.annotations)&&sameSource(a.source,b.source)&&hydroWebPropertyFields(a)==hydroWebPropertyFields(b);});
    if(ref.domain=="generic")return sameContentRow(before.genericFeatures,after.genericFeatures,ref.id,[](const auto& a,const auto& b){
        return std::tie(a.name,a.notes,a.geometry,a.color,a.explicitColor,a.locked)==std::tie(b.name,b.notes,b.geometry,b.color,b.explicitColor,b.locked)&&sameSource(a.source,b.source);});
    if(ref.domain=="distributionLayer")return sameContentRow(before.distributionLayers,after.distributionLayers,ref.id,[](const auto& a,const auto& b){
        return std::tie(a.name,a.unit,a.color,a.explicitColor,a.locked,a.parentId,a.groups,a.validity.from,a.validity.to,a.metadata,a.valueScale.manual,a.valueScale.min,a.valueScale.max)
            ==std::tie(b.name,b.unit,b.color,b.explicitColor,b.locked,b.parentId,b.groups,b.validity.from,b.validity.to,b.metadata,b.valueScale.manual,b.valueScale.min,b.valueScale.max);});
    if(ref.domain=="distributionEntry")return sameContentRow(before.distributionEntries,after.distributionEntries,ref.id,[](const auto& a,const auto& b){
        return std::tie(a.layerId,a.territory,a.geometry,a.value,a.certainty,a.validity.from,a.validity.to,a.metadata)
            ==std::tie(b.layerId,b.territory,b.geometry,b.value,b.certainty,b.validity.from,b.validity.to,b.metadata);});
    return false;
}
}
codecjson::Value webTerritorialIdentityValue(const ProjectDocument& document,const TerritorialUnit& unit){return webIdentity(document,unit);}
codecjson::Value webGeometryValue(const Geometry& geometry) {return geometryValue(geometry);}
codecjson::Value webContentValue(const ProjectSnapshot& snapshot,const ObjectRef& ref,const ContentValue* supplied,const Geometry* geometry) {
    const auto& d=snapshot.document();ContentValue stored;
    if(!supplied) {
        const auto found=snapshot.index().objects.find(ref);require(found!=snapshot.index().objects.end(),"INVALID_WEB_CONTENT_ID");
        const auto index=found->second;
        if(ref.domain=="label")stored=d.labels.at(index);
        else if(ref.domain=="hydro")stored=d.hydro.at(index);
        else if(ref.domain=="generic")stored=d.genericFeatures.at(index);
        else if(ref.domain=="distributionLayer")stored=d.distributionLayers.at(index);
        else if(ref.domain=="distributionEntry")stored=d.distributionEntries.at(index);
        else throw std::invalid_argument("UNSUPPORTED_WEB_CONTENT_DOMAIN");supplied=&stored;
    }
    return std::visit([&](const auto& value)->V {
        using T=std::decay_t<decltype(value)>;
        if constexpr(std::is_same_v<T,PlaceLabel>)return webLabel(d,value,geometry);
        else if constexpr(std::is_same_v<T,HydroFeature>)return webHydro(d,value,geometry);
        else if constexpr(std::is_same_v<T,GenericFeature>)return webGeneric(d,value,geometry);
        else if constexpr(std::is_same_v<T,DistributionLayer>)return webDistributionLayer(value);
        else if constexpr(std::is_same_v<T,DistributionEntry>)return webDistributionEntry(d,value,geometry);
        else throw std::invalid_argument("INVALID_WEB_CONTENT_VALUE");
    },*supplied);
}
namespace {
V webSnapshotValue(const ProjectDocument& d,const WebStorageContext& context) {
    auto root=currentWebHeader();for(const auto& [key,value]:jsonObject(d.exchangeMetadata).object)root.object[key]=value;
    if(context.version)root.object["version"]=V::str(*context.version);if(context.savedAt)root.object["savedAt"]=V::str(*context.savedAt);
    validateHeader(root,d);root.object["format"]=V::str(context.format);root.object["schemaVersion"]=V::num(ProjectVersion);root.object["documentId"]=V::str(d.documentId);
    V units=V::arr(),archive=V::arr(),labels=V::arr(),hydro=V::arr(),generic=V::arr(),layers=V::arr(),entries=V::arr();
    for(const auto& u:d.units)units.array.push_back(webIdentity(d,u));
    for(const auto& [ref,shape]:d.geometries.versions()) {
        const auto allocation=d.geometryProvenance.inlineAllocations.find(ref);
        if(allocation!=d.geometryProvenance.inlineAllocations.end()&&!allocation->second.promoted)continue;
        auto row=V::obj();row.object["id"]=V::str(ref.id);row.object["version"]=V::num(ref.version);
        row.object["geojson"]=geometryValue(*shape);archive.array.push_back(std::move(row));
    }
    for(const auto& label:d.labels)labels.array.push_back(webLabel(d,label));
    for(const auto& value:d.genericFeatures)generic.array.push_back(webGeneric(d,value));
    for(const auto& value:d.hydro)hydro.array.push_back(webHydro(d,value));
    for(const auto& value:d.distributionLayers)layers.array.push_back(webDistributionLayer(value));
    for(const auto& value:d.distributionEntries)entries.array.push_back(webDistributionEntry(d,value));
    root.object["territorialEntities"]=std::move(units);root.object["timelineRecords"]=timelineRecordsValue(d.timelineRecords);
    root.object["geometries"]=std::move(archive);root.object["labels"]=std::move(labels);root.object["hydroEdits"]=std::move(hydro);
    root.object["genericFeatures"]=std::move(generic);root.object["distributionLayers"]=std::move(layers);root.object["distributionEntries"]=std::move(entries);
    auto presentation=webPresentationFields(d);
    for(auto& entry:presentation.object)root.object[entry.first]=std::move(entry.second);
    return root;
}
}
std::string webSnapshot(const ProjectSnapshot& snapshot, bool includeGeometryResources) {
    const auto& document = snapshot.document(); validateDocument(document);
    auto root = webSnapshotValue(document,{});
    if (includeGeometryResources&&!document.geometries.resources().empty()) {
        V rows = V::arr();
        for (const auto& [ref, resource]:document.geometries.resources()) {
            V row = V::obj(); row.object["id"] = V::str(ref.id); row.object["version"] = V::num(ref.version);
            row.object["type"] = V::str(resource.type); row.object["contentSha256"] = V::str(resource.contentSha256);
            row.object["decodedBytes"] = V::num(resource.decodedBytes); rows.array.push_back(std::move(row));
        }
        root.object["geometryResources"] = std::move(rows);
    }
    return root.encode();
}
codecjson::Value encodeWebValue(const ProjectSnapshot& snapshot,const PlatformPorts& ports,const WebStorageContext& context) {
    require(bool(ports.validateFlagDataUrl),"CODEC_PLATFORM_REQUIRED: flag validator");
    const auto& d=snapshot.document();validateDocument(d);validateWebObjectIds(d);validateProvenanceDigests(d);
    std::vector<GeometryRef> required;for(const auto& [ref,resource]:d.geometries.resources())required.push_back(ref);
    d.geometries.requireReady(required);
    require(!d.geometryProvenance.opaqueUncertain||!hasUnpromotedInlineAllocations(d.geometryProvenance),
            "UNSUPPORTED_WEB_EXPORT: opaque geometry dependencies");
    for(const auto& [key,value]:d.presentation.webPresentation.visibility)if(!webLayerVisibilityKey(key))throw std::invalid_argument("UNSUPPORTED_WEB_EXPORT: layerVisibility/"+key);
    for(const auto& [key,value]:d.presentation.webPresentation.itemVisibility)if(!webItemVisibilityKey(key))throw std::invalid_argument("UNSUPPORTED_WEB_EXPORT: itemVisibility/"+key);
    for(const auto& [owner,symbol]:d.symbols)
        require(symbol.defaultCountryId.empty()&&!symbol.defaultFlagDataUrl.has_value(),
                "UNSUPPORTED_WEB_EXPORT: native captured flag defaults");
    require(d.extensions.empty(),"UNSUPPORTED_WEB_EXPORT: retained native extensions");require(d.physicalData.dataset.empty()&&d.physicalData.version.empty()&&d.physicalData.source.empty()&&d.physicalData.hiddenHydroIds.empty(),"UNSUPPORTED_WEB_EXPORT: native physical dataset settings");for(const auto& [owner,style]:d.presentation.objectStyles)require(owner.domain=="territorial","UNSUPPORTED_WEB_EXPORT: native non-territorial style override");
    require(context.format=="pandolab-project-state"||context.format=="pandolab-autosave-full","UNSUPPORTED_WEB_STORAGE_FORMAT");
    const auto archiveCount=semanticArchive(d).size();
    auto root=webSnapshotValue(d,context);
    for(const auto* key:{"layerVisibility","itemVisibility"})root.object.erase(key);
    requireWebNumbers(root);
    // Validate the DTO directly: storage changes its envelope before encoding,
    // and must not serialize/parse the entire archive just to obtain this tree.
    const auto restored=decodeWebValue(root,ports);
    // Web has no version carrier for a private inline shape. Only its exact
    // single owner may reload an omitted allocation at a new private version;
    // explicit archive references and shared/promoted references stay exact.
    const auto beforeUsers=geometryProvenanceUsers(d),afterUsers=geometryProvenanceUsers(restored);
    const auto privateReload=[&](const ObjectRef& owner,const GeometryRef& before,const GeometryRef& after) {
        if(d.geometryProvenance.originalArchive.count(before)||restored.geometryProvenance.originalArchive.count(after))return false;
        const auto a=d.geometryProvenance.inlineAllocations.find(before),b=restored.geometryProvenance.inlineAllocations.find(after);
        if(a==d.geometryProvenance.inlineAllocations.end()||b==restored.geometryProvenance.inlineAllocations.end())return false;
        if(a->second.promoted||b->second.promoted||!(a->second.createdFor==owner)||!(b->second.createdFor==owner))return false;
        const std::string canonical=std::string("web-")+webContentGeometryDomain(owner.domain)+":"+owner.id;
        if(!before.version||!after.version||before.id!=canonical||after.id!=canonical)return false;
        const auto oldUsers=beforeUsers.find(before),newUsers=afterUsers.find(after);
        if(oldUsers==beforeUsers.end()||newUsers==afterUsers.end()||oldUsers->second.size()!=1||newUsers->second.size()!=1
                ||!(oldUsers->second[0]==owner)||!(newUsers->second[0]==owner))return false;
        const auto oldShape=d.geometries.get(before),newShape=restored.geometries.get(after);
        if(!oldShape||!newShape)return false;
        const auto encoded=geometryValue(*oldShape).encode();
        return encoded==geometryValue(*newShape).encode()&&a->second.geometrySha256==b->second.geometrySha256
            &&sha256Bytes(encoded)==a->second.geometrySha256;
    };
    const auto requirePreservedInlineRefs=[&](const char* domain,const auto& before,const auto& after){
        require(before.size()==after.size(),"UNSUPPORTED_WEB_EXPORT: non-territorial geometry reference loss");
        for(std::size_t i=0;i<before.size();++i) {
            require(before[i].id==after[i].id,"UNSUPPORTED_WEB_EXPORT: non-territorial geometry reference loss");
            if(before[i].geometry==after[i].geometry)continue;
            const auto optional=[](const auto& value)->std::optional<GeometryRef>{return value;};
            const auto oldRef=optional(before[i].geometry),newRef=optional(after[i].geometry);
            require(oldRef&&newRef&&privateReload({domain,before[i].id},*oldRef,*newRef),
                    "UNSUPPORTED_WEB_EXPORT: non-territorial geometry reference loss");
        }
    };
    requirePreservedInlineRefs("label",d.labels,restored.labels);
    requirePreservedInlineRefs("generic",d.genericFeatures,restored.genericFeatures);requirePreservedInlineRefs("distributionEntry",d.distributionEntries,restored.distributionEntries);
    for(const auto& ref:restored.geometryProvenance.originalArchive) {
        const auto before=d.geometries.get(ref),after=restored.geometries.get(ref);
        require(before&&after&&geometryValue(*before).encode()==geometryValue(*after).encode(),
                "UNSUPPORTED_WEB_EXPORT: semantic geometry archive loss");
    }
    require(restored.geometryProvenance.originalArchive.size()==archiveCount,
            "UNSUPPORTED_WEB_EXPORT: semantic geometry archive loss");
    return root;
}
std::string encodeWeb(const ProjectSnapshot& snapshot,const PlatformPorts& ports,const WebStorageContext& context) {
    const auto bytes=encodeWebValue(snapshot,ports,context).encode()+"\n";
    require(bytes.size()<=256ll*1024*1024,"LIMIT_EXCEEDED");return bytes;
}

std::string encodeWebDelta(const ProjectDocument& before,const ProjectDocument& after,const ChangeImpact& impact) {
    auto objects=V::arr(),geometries=V::arr(),removed=V::arr(),orders=V::obj();
    std::set<std::string> identityDomains,geometryDomains;
    const auto contentGeometry=[&](const ProjectDocument& d,const ObjectRef& ref)->std::optional<GeometryRef>{
        if(ref.domain=="label")for(const auto& row:d.labels)if(row.id==ref.id)return row.geometry;
        if(ref.domain=="generic")for(const auto& row:d.genericFeatures)if(row.id==ref.id)return row.geometry;
        if(ref.domain=="distributionEntry")for(const auto& row:d.distributionEntries)if(row.id==ref.id)return row.geometry;
        return {};
    };
    const auto order=[&](const char* domain,const auto& rows){auto value=V::arr();for(const auto& row:rows)value.array.push_back(V::str(row.id));orders.object[domain]=std::move(value);};
    order("territorial",after.units);order("label",after.labels);order("hydro",after.hydro);
    order("generic",after.genericFeatures);order("distributionLayer",after.distributionLayers);order("distributionEntry",after.distributionEntries);
    for(const auto& ref:impact.changedObjects) {
        if(unchangedWebObject(before,after,ref))continue;
        identityDomains.insert(ref.domain);
        V value;std::int64_t index=-1;
        if(ref.domain=="territorial") {
            for(std::size_t i=0;i<after.units.size();++i)if(after.units[i].id==ref.id){value=webIdentity(after,after.units[i]);index=static_cast<std::int64_t>(i);break;}
        }
        else {
            std::pair<V,std::int64_t> row;
            if(ref.domain=="label")row=objectAt(after.labels,ref.id,[&](const auto& item){return webLabel(after,item);});
            else if(ref.domain=="hydro")row=objectAt(after.hydro,ref.id,[&](const auto& item){return webHydro(after,item);});
            else if(ref.domain=="generic")row=objectAt(after.genericFeatures,ref.id,[&](const auto& item){return webGeneric(after,item);});
            else if(ref.domain=="distributionLayer")row=objectAt(after.distributionLayers,ref.id,webDistributionLayer);
            else if(ref.domain=="distributionEntry")row=objectAt(after.distributionEntries,ref.id,[&](const auto& item){return webDistributionEntry(after,item);});
            else throw std::invalid_argument("CORE_DELTA_DOMAIN: "+ref.domain);
            value=std::move(row.first);index=row.second;
        }
        const auto oldGeometry=contentGeometry(before,ref),newGeometry=contentGeometry(after,ref);
        const bool geometryChanged=!(oldGeometry==newGeometry);
        if(geometryChanged)geometryDomains.insert(ref.domain);
        objects.array.push_back(object({{"ref",refValue(ref)},{"value",std::move(value)},{"index",V::num(static_cast<double>(index))},{"geometryChanged",V::boolean(geometryChanged)}}));
    }
    const auto beforeArchive=semanticArchive(before),afterArchive=semanticArchive(after);
    // Undo can unpublish an inline allocation without deleting its native
    // archive entry. Redo must admit it again even when the allocation itself
    // did not change: the Web read model owns the published semantic archive.
    std::set<GeometryRef> publishedGeometries(impact.changedGeometries.begin(),impact.changedGeometries.end());
    for(const auto& ref:afterArchive)if(!beforeArchive.count(ref))publishedGeometries.insert(ref);
    for(const auto& ref:publishedGeometries) {
        if(!afterArchive.count(ref))continue;
        const auto shape=after.geometries.get(ref);if(shape)geometries.array.push_back(object({{"id",V::str(ref.id)},{"version",V::num(ref.version)},{"geojson",geometryValue(*shape)}}));
    }
    for(const auto& ref:beforeArchive)if(!afterArchive.count(ref))removed.array.push_back(geometryRefValue(ref));
    const auto beforeTimeline=timelineRecordsValue(before.timelineRecords).encode();
    const auto afterTimeline=timelineRecordsValue(after.timelineRecords);
    const bool timelineChanged=beforeTimeline!=afterTimeline.encode();
    if(timelineChanged&&timelineRecordsValue(before.timelineRecords).object.at("geometryBindings").encode()!=afterTimeline.object.at("geometryBindings").encode())geometryDomains.insert("territorial");
    auto identityKinds=V::arr(),geometryKinds=V::arr();for(const auto& domain:identityDomains)identityKinds.array.push_back(V::str(domain));for(const auto& domain:geometryDomains)geometryKinds.array.push_back(V::str(domain));
    auto header=V::obj(),removedHeader=V::arr();const auto oldHeader=codecjson::parse(before.exchangeMetadata),newHeader=codecjson::parse(after.exchangeMetadata);
    for(const auto& [key,value]:newHeader.object){const auto old=oldHeader.object.find(key);if(old==oldHeader.object.end()||old->second.encode()!=value.encode())header.object[key]=value;}
    for(const auto& [key,value]:oldHeader.object)if(!newHeader.object.count(key))removedHeader.array.push_back(V::str(key));
    const bool headerChanged=!header.object.empty()||!removedHeader.array.empty();
    const auto result=object({{"objects",objects},{"orders",orders},{"geometries",geometries},{"removedGeometryRefs",removed},
        {"timelineRecords",timelineChanged?afterTimeline:V{}},
        {"impact",object({{"geometryDomains",std::move(geometryKinds)},{"identityDomains",std::move(identityKinds)},{"timelineChanged",V::boolean(timelineChanged)}})},
        {"presentation",before.presentation.webPresentation==after.presentation.webPresentation?V{}:webPresentationFields(after)},
        {"provenance",before.geometryProvenance==after.geometryProvenance?V{}:geometryProvenanceValue(after.geometryProvenance)},
        {"header",headerChanged?object({{"set",std::move(header)},{"removedKeys",std::move(removedHeader)}}):V{}}});
    return result.encode();
}
}
