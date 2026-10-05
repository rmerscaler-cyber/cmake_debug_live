#include "mixed_api.h"

class Counter {
public:
    int add(int value) {
        total_ += c_double(value);  // C++ calls back into the C module.
        return total_;
    }

private:
    int total_ = 0;
};

static Counter counter;

extern "C" int cpp_accumulate(int value) {
    return counter.add(value);
}
