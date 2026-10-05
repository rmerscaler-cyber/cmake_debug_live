cmake_minimum_required(VERSION 3.16)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
project(rm_debug_desktop LANGUAGES C CXX)

add_executable(app main.c c_math.c cpp_module.cpp)
target_compile_features(app PRIVATE c_std_11 cxx_std_20)
