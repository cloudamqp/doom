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
           -sEXIT_RUNTIME -sENVIRONMENT=web,node -sEXPORTED_RUNTIME_METHODS=FS,HEAP32 \
           -sEXPORTED_FUNCTIONS=_main,_M_SaveDefaults

all: $(OUT)/doom.js $(OUT)/oplrender.cjs

$(OUT)/doom.js: $(OBJ)
	emcc $(LDFLAGS) $(OBJ) -o $@

# Renders music from the IWAD for the lobby, see tools/oplrender.c. Shares
# the game's objects, which run in Node as well as in the browser.
TOOL_OBJ := $(addprefix $(OUT)/obj/,tools/oplrender.o src/i_oplmusic.o src/midifile.o src/mus2mid.o \
              src/memio.o src/m_misc.o opl/opl.o opl/opl3.o opl/opl_queue.o)

$(OUT)/oplrender.cjs: $(TOOL_OBJ)
	emcc -O2 $(PORTS) -sENVIRONMENT=node -sNODERAWFS -sEXIT_RUNTIME -sALLOW_MEMORY_GROWTH $(TOOL_OBJ) -o $@

# Rebuild everything when flags change
$(OUT)/doom.js $(OUT)/oplrender.cjs $(OBJ) $(TOOL_OBJ): Makefile

$(OUT)/obj/%.o: %.c
	@mkdir -p $(@D)
	emcc $(CFLAGS) -MMD -c $< -o $@

clean:
	rm -rf $(OUT)

.PHONY: all clean

-include $(OBJ:.o=.d) $(OUT)/obj/tools/oplrender.d
