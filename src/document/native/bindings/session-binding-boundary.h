#pragma once

#include <pandoeditor/document-session.h>
#include <pandoeditor/losslessjson.h>
#include <emscripten/val.h>
#include <algorithm>
#include <cmath>
#include <exception>
#include <initializer_list>
#include <optional>
#include <string>

namespace pandoeditor::wasm_session_detail {
using emscripten::val;

[[noreturn]] inline void fail(const std::string& code,const std::string& detail) { throw TimelineError(code,detail); }
inline bool type(const val& value,const char* expected) { return value.typeOf().as<std::string>()==expected; }
inline void array(const val& value,const char* code) {
    if(!val::global("Array").call<bool>("isArray",value))fail(code,"An array is required.");
}
inline void shape(const val& value,std::initializer_list<const char*> fields,const char* code="TIMELINE_SCHEMA") {
    if(value.isNull()||!type(value,"object")||val::global("Array").call<bool>("isArray",value))
        fail(code,"An object is required.");
    const auto keys=val::global("Object").call<val>("keys",value);
    if(keys["length"].as<unsigned>()!=fields.size())fail(code,"Unexpected or missing fields.");
    for(const auto* field:fields)
        if(!val::global("Object").call<bool>("hasOwn",value,std::string(field)))fail(code,"Missing field.");
}
inline std::string text(const val& value,const char* code,bool empty=false) {
    if(!type(value,"string"))fail(code,"A string is required.");
    // Emscripten's direct UTF-8 string conversion merges lone UTF-16 units.
    // JSON.stringify escapes those units, and the shared Web parser preserves
    // their exact interpreted value for names and annotations.
    const auto result=codecjson::parse(val::global("JSON").call<val>("stringify",value).as<std::string>()).string;
    if(!empty&&result.empty())fail(code,"A nonempty string is required.");
    return result;
}
inline val webString(const std::string& value) {return val::global("JSON").call<val>("parse",codecjson::Value::str(value).encode());}
inline val optional(const std::optional<std::string>& value) { return value?webString(*value):val::null(); }

inline int integer(const val& value,const char* code) {
    if(!type(value,"number"))fail(code,"An integer is required.");const auto number=value.as<double>();
    if(!std::isfinite(number)||std::floor(number)!=number||number<-2147483648.0||number>2147483647.0)
        fail(code,"Invalid integer.");return static_cast<int>(number);
}

template<class Function> auto boundary(Function function)->decltype(function()) {
    try { return function(); }
    catch(const GeometryUnavailable& error) {
        auto value=val::global("Error").new_(std::string(error.what())),refs=val::array();unsigned i=0;
        for(const auto& ref:error.refs){auto row=val::object();row.set("id",webString(ref.id));row.set("version",ref.version);refs.set(i++,row);}
        value.set("code","GEOMETRY_UNLOADED");value.set("missingGeometryRefs",refs);value.throw_();
    } catch(const TimelineError& error) {
        auto value=val::global("Error").new_(std::string(error.what()));value.set("code",error.code);value.throw_();
    } catch(const std::exception& error) {
        const std::string message=error.what();
        if(message.rfind("URI_MALFORMED:",0)==0)val::global("URIError").new_(std::string("URI malformed")).throw_();
        auto value=val::global("Error").new_(message);
        auto code=message.substr(0,message.find(':'));
        if(code.empty()||!std::all_of(code.begin(),code.end(),[](char ch){return (ch>='A'&&ch<='Z')||(ch>='0'&&ch<='9')||ch=='_'||ch=='-';}))code="CORE_SESSION_ERROR";
        if(message.rfind("INVALID_DATE:",0)==0)code="PL-TEMPORAL-001";
        value.set("code",code);value.throw_();
    }
    std::terminate();
}

void registerDocumentCalculationBindings();
}
