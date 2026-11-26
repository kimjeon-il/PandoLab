#include <pandoeditor/projectcodec.h>
#include <array>
#include <cstdint>
#include <iomanip>
#include <sstream>

namespace pandoeditor::projectcodec {
std::string sha256Bytes(const std::string& input) {
    constexpr std::array<std::uint32_t, 64> constants{{
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2}};
    std::array<std::uint32_t, 8> state{{0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19}};
    auto bytes = input; bytes+=static_cast<char>(0x80); while (bytes.size()%64!=56)bytes+='\0';
    const std::uint64_t bits = static_cast<std::uint64_t>(input.size())*8;
    for (int shift = 56; shift>=0; shift-=8)bytes+=static_cast<char>((bits>>shift)&255);
    const auto rotate = [](std::uint32_t value, unsigned shift) {return (value>>shift)|(value<<(32-shift));};
    for (std::size_t offset = 0; offset<bytes.size(); offset+=64) {
        std::array<std::uint32_t, 64> schedule{};
        for (unsigned i = 0; i<16; ++i)for (unsigned j = 0; j<4; ++j)schedule[i] = (schedule[i]<<8)|static_cast<unsigned char>(bytes[offset+i*4+j]);
        for (unsigned i = 16; i<64; ++i) {
            const auto a = schedule[i-15], b = schedule[i-2];
            schedule[i] = schedule[i-16]+(rotate(a, 7)^rotate(a, 18)^(a>>3))+schedule[i-7]+(rotate(b, 17)^rotate(b, 19)^(b>>10));
        }
        auto a = state[0], b = state[1], c = state[2], d = state[3], e = state[4], f = state[5], g = state[6], h = state[7];
        for (unsigned i = 0; i<64; ++i) {
            const auto t1 = h+(rotate(e, 6)^rotate(e, 11)^rotate(e, 25))+((e&f)^((~e)&g))+constants[i]+schedule[i];
            const auto t2 = (rotate(a, 2)^rotate(a, 13)^rotate(a, 22))+((a&b)^(a&c)^(b&c));
            h = g; g = f; f = e; e = d+t1; d = c; c = b; b = a; a = t1+t2;
        }
        const std::array<std::uint32_t, 8> next{{a, b, c, d, e, f, g, h}}; for (unsigned i = 0; i<8; ++i)state[i]+=next[i];
    }
    std::ostringstream output; output<<std::hex<<std::setfill('0'); for (const auto value:state)output<<std::setw(8)<<value; return output.str();
}
}
