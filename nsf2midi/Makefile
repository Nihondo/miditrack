# Makefile for nsf2midi (macOS CLI port)
#
# NotSoFatso (third_party/NotSoFatso) uses the `register` storage class
# specifier, which was removed in C++17. Building as C++14 keeps the vendored
# source unmodified.

CXX      ?= c++
CC       ?= cc
# third_party/NotSoFatso uses the pre-C++17 `register` keyword, so it is built
# as C++14. Our own sources use std::optional (C++17), so they are built
# separately as C++17. Both object sets link together without issue.
NSF_CXXSTD := -std=c++14
APP_CXXSTD := -std=c++17
CFLAGS_COMMON := -O2 -Wno-deprecated -Wno-ignored-attributes -Wno-comment -Wno-register

NSF_DIR  := third_party/NotSoFatso
SRC_DIR  := src

NSF_CPP_SRCS := $(NSF_DIR)/NSF_Core.cpp $(NSF_DIR)/NSF_File.cpp $(NSF_DIR)/NSF_6502.cpp $(NSF_DIR)/Wave_VRC7.cpp
NSF_C_SRCS   := $(NSF_DIR)/fmopl.c

APP_SRCS := $(SRC_DIR)/main.cpp $(SRC_DIR)/mdf.cpp $(SRC_DIR)/channel_map.cpp \
            $(SRC_DIR)/pitch.cpp $(SRC_DIR)/detector.cpp $(SRC_DIR)/smf.cpp \
            $(SRC_DIR)/midi2wav.cpp $(SRC_DIR)/wav_writer.cpp $(SRC_DIR)/chip_render.cpp \
            $(SRC_DIR)/track_metadata.cpp

OBJ_DIR := build
NSF_CPP_OBJS := $(patsubst $(NSF_DIR)/%.cpp,$(OBJ_DIR)/nsf_%.o,$(NSF_CPP_SRCS))
NSF_C_OBJS   := $(patsubst $(NSF_DIR)/%.c,$(OBJ_DIR)/nsf_%.o,$(NSF_C_SRCS))
APP_OBJS     := $(patsubst $(SRC_DIR)/%.cpp,$(OBJ_DIR)/app_%.o,$(APP_SRCS))

TARGET := nsf2midi

INCLUDES := -I$(NSF_DIR) -I$(SRC_DIR)

# detector/mdf/pitch/smf の単体テスト。third_party/NotSoFatso には依存しない
# (FrameState を直接組み立てて渡すため)ので、NSF_* オブジェクトはリンクしない。
TEST_SRC    := tests/test_detector.cpp
TEST_TARGET := $(OBJ_DIR)/test_detector

.PHONY: all clean test

all: $(TARGET)

test: $(TEST_TARGET)
	./$(TEST_TARGET)

$(TEST_TARGET): $(TEST_SRC) $(SRC_DIR)/mdf.cpp $(SRC_DIR)/pitch.cpp $(SRC_DIR)/detector.cpp $(SRC_DIR)/smf.cpp $(SRC_DIR)/wav_writer.cpp | $(OBJ_DIR)
	$(CXX) $(APP_CXXSTD) $(CFLAGS_COMMON) -I$(SRC_DIR) -o $@ $^

$(TARGET): $(NSF_CPP_OBJS) $(NSF_C_OBJS) $(APP_OBJS)
	$(CXX) $(APP_CXXSTD) -o $@ $^

$(OBJ_DIR)/nsf_%.o: $(NSF_DIR)/%.cpp | $(OBJ_DIR)
	$(CXX) $(NSF_CXXSTD) $(CFLAGS_COMMON) $(INCLUDES) -c $< -o $@

$(OBJ_DIR)/nsf_%.o: $(NSF_DIR)/%.c | $(OBJ_DIR)
	$(CC) $(CFLAGS_COMMON) $(INCLUDES) -c $< -o $@

$(OBJ_DIR)/app_%.o: $(SRC_DIR)/%.cpp | $(OBJ_DIR)
	$(CXX) $(APP_CXXSTD) $(CFLAGS_COMMON) $(INCLUDES) -c $< -o $@

$(OBJ_DIR):
	mkdir -p $(OBJ_DIR)

clean:
	rm -rf $(OBJ_DIR) $(TARGET)
