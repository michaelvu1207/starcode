cmake_minimum_required(VERSION 3.22.1)

project(starcodeterminal LANGUAGES CXX)

add_library(ghostty-vt SHARED IMPORTED)
set_target_properties(
  ghostty-vt
  PROPERTIES IMPORTED_LOCATION
             "${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libghostty-vt.so"
)

add_library(starcodeterminal SHARED starcode_terminal_jni.cpp)

target_include_directories(
  starcodeterminal
  PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../../../../Vendor/libghostty-vt/include"
)

target_link_options(
  starcodeterminal PRIVATE "-Wl,-z,common-page-size=16384" "-Wl,-z,max-page-size=16384"
)

target_link_libraries(starcodeterminal PRIVATE ghostty-vt log)
