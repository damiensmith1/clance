{
  "targets": [
    {
      "target_name": "ax",
      "sources": ["ax.mm"],
      "defines": ["NAPI_VERSION=8"],
      "xcode_settings": {
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "MACOSX_DEPLOYMENT_TARGET": "11.0"
      },
      "link_settings": {
        "libraries": [
          "-framework Foundation",
          "-framework AppKit",
          "-framework ApplicationServices"
        ]
      }
    }
  ]
}
