# rm_debug target: ${CMAKE_PROJECT_NAME}
# demo CMake 分组

# rm_debug BEGIN managed sources
target_sources(${CMAKE_PROJECT_NAME} PRIVATE
    "${CMAKE_CURRENT_LIST_DIR}/../Core/Src/bsp_rc.c"
    "${CMAKE_CURRENT_LIST_DIR}/../Core/Src/bsp_usart.c"
    "${CMAKE_CURRENT_LIST_DIR}/../Core/Src/remote_control.c"
    "${CMAKE_CURRENT_LIST_DIR}/../Core/Src/rm_debug_demo.c"
)
# rm_debug END managed sources
