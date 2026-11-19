#pragma once
#include <pandoeditor/projectcodec.h>

namespace pandoeditor {
std::string webCommandString(const codecjson::Value&);
std::optional<double> webCommandNumber(const codecjson::Value&);
}
