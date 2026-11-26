#include <pandoeditor/document.h>
#include <pandoeditor/timeline-resolver.h>
#include <pandoeditor/losslessjson.h>
#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace pandoeditor {
std::set<std::string> labelSettingsWebFields(const LabelSettings& value) {
    return value.webFields?*value.webFields:std::set<std::string>{"priority","minZoom","maxZoom","manualPosition","pinned","collisionGroup"};
}
bool LabelSettings::operator==(const LabelSettings& b) const {
    const auto point=[](const std::optional<Point>& p){return p?std::make_tuple(true,p->x,p->y):std::make_tuple(false,0.,0.);};
    return priority==b.priority&&minZoom==b.minZoom&&maxZoom==b.maxZoom&&point(manualPosition)==point(b.manualPosition)&&pinned==b.pinned&&collisionGroup==b.collisionGroup&&annotations==b.annotations&&labelSettingsWebFields(*this)==labelSettingsWebFields(b)&&webMinZoomNull==b.webMinZoomNull;
}
std::string territorialGroup(const ProjectDocument& d,const std::string& id) {
    if(std::none_of(d.units.begin(),d.units.end(),[&](const auto& row){return row.id==id;}))throw std::invalid_argument("INVALID_TARGETS");
    return "objects";
}
std::string territorialPresentationKey(const std::string& id) { return "territorial:entity:"+id; }
bool groupVisible(const WebPresentation& p,const std::string& g) { auto i=p.visibility.find(g);return i==p.visibility.end()||i->second; }
bool itemVisible(const WebPresentation& p,const std::string& g,const std::string& id) { auto i=p.itemVisibility.find(g);return i==p.itemVisibility.end()||!i->second.count(id)||i->second.at(id); }
std::string contentItemGroup(const ProjectDocument& d,const ObjectRef& ref) {
    return ref.domain=="hydro"?"hydro":contentGroup(d,ref);
}
namespace {
const TerritorialUnit* unit(const ProjectDocument& d,const ObjectRef& ref) { if(ref.domain!="territorial")return nullptr;for(const auto& u:d.units)if(u.id==ref.id)return &u;return nullptr; }
std::vector<ObjectRef> contentRefs(const ProjectDocument& d) {
    std::vector<ObjectRef> refs;
    auto add=[&](const auto& values,const char* domain){for(const auto& v:values)refs.push_back({domain,v.id});};
    add(d.labels,"label");add(d.hydro,"hydro");add(d.genericFeatures,"generic");add(d.distributionLayers,"distributionLayer");add(d.distributionEntries,"distributionEntry");return refs;
}
}
void normalizePresentation(ProjectDocument& d,const std::string&) {
    auto& p=d.presentation.webPresentation;std::set<std::string> keys;std::map<std::string,std::set<std::string>> ids;
    for(const auto& u:d.units) {
        const std::string group="objects";
        ids[group].insert(u.id);keys.insert(territorialPresentationKey(u.id));
    }
    for(const auto& ref:contentRefs(d))ids[contentItemGroup(d,ref)].insert(ref.id);
    if(d.presentation.catalog) {
        for(const auto& [id,kind]:d.presentation.catalog->hydroLayers)ids["hydro"].insert(id);
        for(const auto& id:d.presentation.catalog->countryLabelIds)ids["objectLabels"].insert(id);
    }
    for(auto& [g,hidden]:p.itemVisibility)for(auto i=hidden.begin();i!=hidden.end();)if(!ids[g].count(i->first))i=hidden.erase(i);else ++i;
    for(auto i=p.objectStyles.begin();i!=p.objectStyles.end();)if(!keys.count(i->first))i=p.objectStyles.erase(i);else ++i;
    std::set<std::string> seen;p.objectOrder.erase(std::remove_if(p.objectOrder.begin(),p.objectOrder.end(),[&](const auto& k){return !keys.count(k)||!seen.insert(k).second;}),p.objectOrder.end());
    for(auto i=p.labelSettings.begin();i!=p.labelSettings.end();) {
        if(!std::any_of(d.units.begin(),d.units.end(),[&](const auto& u){return i->first==territorialRef(u.id);})&&
           !std::any_of(d.labels.begin(),d.labels.end(),[&](const auto& v){return i->first==ObjectRef{"label",v.id};})) i=p.labelSettings.erase(i);
        else {if(i->second.collisionGroup.empty())i->second.collisionGroup="map";++i;}
    }
    for(auto* styles:{&p.styles,&p.objectStyles})for(auto& [key,s]:*styles){if(s.boundaryWidth)s.boundaryWidth=1;if(s.blendMode&&*s.blendMode!="multiply")s.blendMode="normal";}
}
void validatePresentation(const ProjectDocument& d) {
    const auto& p=d.presentation.webPresentation;
    std::set<std::string> keys;for(const auto& unit:d.units)keys.insert(territorialPresentationKey(unit.id));
    for(const auto& [key,style]:p.objectStyles)if(!keys.count(key))throw std::invalid_argument("DANGLING_REF: object presentation");
    const std::string prefix="territorial:entity:";
    std::set<std::string> order;for(const auto& key:p.objectOrder)if(key.rfind(prefix,0)!=0||key.size()==prefix.size()||!order.insert(key).second)throw std::invalid_argument("INVALID_PRESENTATION_ORDER");
    if(!p.overlayOrderPresent&&!p.overlayOrder.empty())throw std::invalid_argument("INVALID_OVERLAY_ORDER");
    std::set<std::string> overlays;for(const auto& group:p.overlayOrder)if((group!="genericFeatures"&&group!="distributions"&&group!="objects")||!overlays.insert(group).second)throw std::invalid_argument("INVALID_OVERLAY_ORDER");
    for(const auto* styles:{&p.styles,&p.objectStyles})for(const auto& [key,s]:*styles) {
        if((s.boundaryWidth&&*s.boundaryWidth!=1)||(s.blendMode&&*s.blendMode!="normal"&&*s.blendMode!="multiply"))throw std::invalid_argument("INVALID_PRESENTATION_STYLE");
    }
    for(const auto& entry:p.labelSettings) {
        const auto& ref=entry.first;const auto& s=entry.second;
        const auto annotations=codecjson::parse(s.annotations);
        if(annotations.kind!=codecjson::Value::Object)throw std::invalid_argument("INVALID_LABEL_SETTINGS_ANNOTATIONS");
        for(const auto* key:{"priority","minZoom","maxZoom","manualPosition","pinned","collisionGroup"})if(annotations.object.count(key))throw std::invalid_argument("DUPLICATE_LABEL_SETTINGS_OWNER");
        const bool owner=ref.domain=="territorial"?std::any_of(d.units.begin(),d.units.end(),[&](const auto& u){return u.id==ref.id;}):ref.domain=="label"&&std::any_of(d.labels.begin(),d.labels.end(),[&](const auto& label){return label.id==ref.id;});
        if(!owner)throw std::invalid_argument("DANGLING_REF: label settings");
        auto finite=[](const auto& v){return !v||std::isfinite(*v);};
        const bool validMax=!s.maxZoom||std::isfinite(*s.maxZoom)||*s.maxZoom==INFINITY;
        if((ref.domain!="territorial"&&ref.domain!="label")||!finite(s.priority)||!finite(s.minZoom)||!validMax||
           (s.minZoom&&s.maxZoom&&*s.minZoom>*s.maxZoom)||s.collisionGroup.empty()||
           (s.manualPosition&&(!std::isfinite(s.manualPosition->x)||!std::isfinite(s.manualPosition->y))))throw std::invalid_argument("INVALID_LABEL_SETTINGS");
    }
}

WebPresentation rebasePresentation(const ProjectDocument& current,const ProjectDocument& from,const ProjectDocument& to) {
    auto candidate=to;candidate.presentation.webPresentation=current.presentation.webPresentation;
    auto& out=candidate.presentation.webPresentation;
    const auto priorContent=contentRefs(from);
    for(const auto& ref:contentRefs(to)) {
        if(std::find(priorContent.begin(),priorContent.end(),ref)!=priorContent.end())continue;
        const auto group=contentItemGroup(to,ref);
        if(!itemVisible(to.presentation.webPresentation,group,ref.id))out.itemVisibility[group][ref.id]=false;
        else out.eraseItemVisibility(group,ref.id);
        if(auto settings=to.presentation.webPresentation.labelSettings.find(ref);settings!=to.presentation.webPresentation.labelSettings.end())out.labelSettings[ref]=settings->second;
    }
    for(const auto& u:to.units) {
        if(unit(from,territorialRef(u.id)))continue;
        const auto group=territorialGroup(to,u.id),key=territorialPresentationKey(u.id);
        const auto& restore=to.presentation.webPresentation;
        if(!itemVisible(restore,group,u.id))out.itemVisibility[group][u.id]=false;else out.eraseItemVisibility(group,u.id);
        if(auto settings=restore.labelSettings.find(territorialRef(u.id));settings!=restore.labelSettings.end())out.labelSettings[territorialRef(u.id)]=settings->second;
        if(auto s=restore.objectStyles.find(key);s!=restore.objectStyles.end())out.objectStyles[key]=s->second;
        const auto position=std::find(restore.objectOrder.begin(),restore.objectOrder.end(),key);
        if(position!=restore.objectOrder.end()) {
            auto insert=out.objectOrder.end();
            for(auto next=position+1;next!=restore.objectOrder.end();++next){auto found=std::find(out.objectOrder.begin(),out.objectOrder.end(),*next);if(found!=out.objectOrder.end()){insert=found;break;}}
            out.objectOrder.insert(insert,key);
        }
    }
    normalizePresentation(candidate);return candidate.presentation.webPresentation;
}
}
