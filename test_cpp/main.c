#include <stdio.h>
#include "mixed_api.h"

_Static_assert(sizeof(int) >= 2, "This source must be compiled as C11.");

int main(void) {
    int total = 0;
    for (int value = 1; value <= 5; ++value) {
        total = cpp_accumulate(value);  /* Break here; step into the C++ module. */
    }
    printf("C/C++ mixed debug: total = %d\n", total);
    return total == 30 ? 0 : 1;
}
