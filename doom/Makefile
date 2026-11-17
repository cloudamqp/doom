# Builds Chocolate Doom to WebAssembly. Needs the Emscripten toolchain,
# e.g. inside the emscripten/emsdk image (see ../Dockerfile).

OUT ?= build

SRC := $(filter-out src/d_dedicated.c src/icon.c src/z_native.c,$(wildcard src/*.c)) \
       $(wildcard src/doom/*.c textscreen/*.c opl/*.c pcsound/*.c)
OBJ := $(SRC:%.c=$(OUT)/obj/%.o)

PORTS   := --use-port=sdl2 --use-port=sdl2_mixer -sSDL2_MIXER_FORMATS=[]
CFLAGS  := -O2 -I. -Isrc -Isrc/doom -Itextscreen -Iopl -Ipcsound $(PORTS)
# ASYNCIFY lets Doom's blocking loops sleep without freezing the browser.
# Emscripten's default 64 KB stack is too small for Doom.
LDFLAGS := -O2 $(PORTS) -sASYNCIFY -sSTACK_SIZE=5MB -sALLOW_MEMORY_GROWTH -sFORCE_FILESYSTEM \
           -sEXIT_RUNTIME -sENVIRONMENT=web -sEXPORTED_RUNTIME_METHODS=FS

$(OUT)/doom.js: $(OBJ)
	emcc $(LDFLAGS) $(OBJ) -o $@

# Rebuild everything when flags change
$(OUT)/doom.js $(OBJ): Makefile

$(OUT)/obj/%.o: %.c
	@mkdir -p $(@D)
	emcc $(CFLAGS) -MMD -c $< -o $@

clean:
	rm -rf $(OUT)

.PHONY: clean

-include $(OBJ:.o=.d)
