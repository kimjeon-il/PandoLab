#include <pandoeditor/webcommands.h>
#include <pandoeditor/timeline-view.h>
#include <pandoeditor/temporal.h>
#include <charconv>
#include <cmath>
#include <cstdlib>
#include <regex>

namespace pandoeditor {
namespace {
using V = codecjson::Value;
std::string stringValue(const V& value) {
    if (value.kind==V::Null)return "";
    if (value.kind==V::String)return value.string;
    if (value.kind==V::Bool)return value.raw=="true"?"true":"false";
    if (value.kind==V::Object)return "[object Object]";
    if (value.kind==V::Array) {
        std::string result;
        for (std::size_t i = 0; i<value.array.size(); ++i) {if (i)result+=','; result+=stringValue(value.array[i]);}
        return result;
    }
    const auto number = codecjson::finiteNumber(value);
    if (number==0)return "0";
    // Scientific shortest-significand formatting avoids the default overload's
    // exact fixed integer spelling (1000000000000000128). ECMAScript selects
    // 1000000000000000100 before applying its fixed/exponent display window.
    char buffer[64]; const auto converted = std::to_chars(buffer, buffer+sizeof buffer, number, std::chars_format::scientific);
    if (converted.ec!=std::errc{})throw TimelineError("CORE_COMMAND_PAYLOAD","Cannot interpret number.");
    std::string text(buffer, converted.ptr), sign;
    if (text.front()=='-') {sign = "-"; text.erase(text.begin());}
    auto exponent = text.find_first_of("eE"); int power = 0;
    if (exponent!=std::string::npos) {power = std::stoi(text.substr(exponent+1)); text.resize(exponent);}
    const auto dot = text.find('.'); const auto decimal = dot==std::string::npos?int(text.size()):int(dot);
    if (dot!=std::string::npos)text.erase(dot, 1);
    int position = decimal+power;
    while (text.size()>1&&text.front()=='0') {text.erase(text.begin()); --position;}
    while (text.size()>1&&text.back()=='0')text.pop_back();
    if (position>0&&position<=21) {
        if (position>=int(text.size()))text.append(std::size_t(position)-text.size(),'0');
        else text.insert(std::size_t(position),".");
        return sign+text;
    }
    if (position<=0&&position>-6)return sign+"0."+std::string(std::size_t(-position),'0')+text;
    if (text.size()>1)text.insert(1,".");
    const auto scientific = position-1;
    return sign+text+"e"+(scientific>=0?"+":"")+std::to_string(scientific);
}
}
std::string webCommandString(const V& value) {return stringValue(value);}
std::optional<double> webCommandNumber(const V& value) {
    if (value.kind==V::Number)return codecjson::finiteNumber(value);
    if (value.kind==V::Null)return 0;
    if (value.kind==V::Bool)return value.raw=="true"?1:0;
    if (value.kind==V::Object)return {};
    auto input = trimWebText(webCommandString(value)); if (input.empty())return 0; double number = 0;
    if (input.size()>2&&input[0]=='0'&&(input[1]=='x'||input[1]=='X'||input[1]=='b'||input[1]=='B'||input[1]=='o'||input[1]=='O')) {
        const auto base = input[1]=='x'||input[1]=='X'?16:input[1]=='b'||input[1]=='B'?2:8;
        std::string hex;
        if (base==16) {
            hex = input.substr(2);
            if (!std::regex_match(hex, std::regex("[0-9a-fA-F]+")))return {};
        } else {
            std::string bits;
            for (std::size_t i = 2; i<input.size(); ++i) {
                const int digit = input[i]-'0'; if (digit<0||digit>=base)return {};
                for (int bit = base==2?0:2; bit>=0; --bit)bits.push_back((digit&(1<<bit))?'1':'0');
            }
            bits.insert(0, (4-bits.size()%4)%4,'0');
            for (std::size_t i = 0; i<bits.size(); i+=4) {
                int digit = 0; for (int j = 0; j<4; ++j)digit = digit*2+(bits[i+j]-'0'); hex.push_back("0123456789abcdef"[digit]);
            }
        }
        const auto parsed = std::from_chars(hex.data(), hex.data()+hex.size(), number, std::chars_format::hex);
        if (parsed.ec==std::errc{}&&parsed.ptr==hex.data()+hex.size()&&std::isfinite(number))return number;
    } else if (std::regex_match(input, std::regex("[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?"))) {
        if (input.front()=='+')input.erase(input.begin());
        const auto parsed = std::from_chars(input.data(), input.data()+input.size(), number, std::chars_format::general);
        if (parsed.ec==std::errc{}&&parsed.ptr==input.data()+input.size()&&std::isfinite(number))return number;
        if (parsed.ec==std::errc::result_out_of_range) {
            char* end = nullptr; number = std::strtod(input.c_str(), &end);
            if (end==input.c_str()+input.size()&&std::isfinite(number))return number;
        }
    }
    return {};
}
}
