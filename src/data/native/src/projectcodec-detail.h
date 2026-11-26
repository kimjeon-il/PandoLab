#pragma once

#include <pandoeditor/projectcodec.h>
#include <initializer_list>

// Internal wire-codec primitives shared by decoding, encoding and provenance.
// The public projectcodec.h remains the only supported external contract.
namespace pandoeditor::projectcodec::codec_detail {
using V = codecjson::Value;
using codecjson::require;

V object(std::initializer_list<std::pair<const std::string, V>> entries);
const V& field(const V& value, const std::string& key);
V colorValue(std::uint32_t value);
V refValue(const ObjectRef& ref);
V geometryRefValue(const GeometryRef& ref);
V pointValue(Point point);
V geometryValue(const Geometry& geometry);
V jsonObject(const std::string& bytes);
V webAnnotation(const std::string& bytes);
V currentWebHeader();
void validateHeader(const V& header, const ProjectDocument& document);
void validateWebObjectIds(const ProjectDocument& document);
bool webLayerVisibilityKey(const std::string& key);
bool webItemVisibilityKey(const std::string& key);
const char* webContentGeometryDomain(const std::string& domain);
bool hasUnpromotedInlineAllocations(const GeometryProvenance& provenance);
void validateProvenanceDigests(const ProjectDocument& document, bool wireIds = true);
std::string pointer(const std::string& base, const std::string& key);
std::string opaqueSha256(const std::string& payload);
}
