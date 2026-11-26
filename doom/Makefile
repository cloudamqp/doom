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

# The native build: a headless Doom for bots, see native/platform.c.
# It needs a C compiler only, e.g. make native
NATIVE_SKIP := d_dedicated gusconf i_cdmus i_endoom i_input i_joystick i_midipipe i_musicpack \
               i_oplmusic i_pcsound i_sdlmusic i_sdlsound i_sound i_timer i_video i_videohr icon \
               midifile mus2mid net_gui z_native
# b_bot.c hands the game to the bot in JavaScript, see ../bot
NATIVE_SRC  := $(filter-out $(NATIVE_SKIP:%=src/%.c),$(wildcard src/*.c)) \
               $(filter-out src/doom/b_bot.c,$(wildcard src/doom/*.c)) $(wildcard native/*.c)
NATIVE_OBJ  := $(NATIVE_SRC:%.c=$(OUT)/native/obj/%.o)
NATIVE_CFLAGS := -O2 -g -I. -Inative -Inative/sdl -Isrc -Isrc/doom $(shell pkg-config --cflags openssl)
# TLS to the broker (mqtts://) needs OpenSSL, 3 or newer
NATIVE_LIBS := -lm $(shell pkg-config --libs openssl)

# The native bot's own files once more as a library, for bots to take on new
# code while they play, see native/reload.c. The library uses the game's
# functions and data, so the program has to export them.
BOT_SRC := $(filter-out src/doom/b_bot.c,$(wildcard src/doom/b_*.c))
ifeq ($(shell uname -s),Darwin)
EXPORT  := -Wl,-export_dynamic
BOT_LIB := -dynamiclib -undefined dynamic_lookup
else
EXPORT  := -rdynamic
# The program has a bot of the same names: the library calls its own
BOT_LIB := -shared -Wl,-Bsymbolic
endif

native: $(OUT)/native/doomq-bot $(OUT)/native/bot.so

# Only the library: what to run while bots play with -botlib
botlib: $(OUT)/native/bot.so

$(OUT)/native/doomq-bot: $(NATIVE_OBJ)
	$(CC) $(NATIVE_OBJ) $(NATIVE_LIBS) $(EXPORT) -o $@

# Built aside and moved in place, so that a bot never loads half of it
$(OUT)/native/bot.so: $(BOT_SRC) $(wildcard src/doom/b_*.h) Makefile
	@mkdir -p $(@D)
	$(CC) $(NATIVE_CFLAGS) -fPIC $(BOT_LIB) $(BOT_SRC) -lm -o $@.new
	mv $@.new $@

$(NATIVE_OBJ): Makefile

$(OUT)/native/obj/%.o: %.c
	@mkdir -p $(@D)
	$(CC) $(NATIVE_CFLAGS) -MMD -c $< -o $@

# Unit tests of the bot's pure code (src/doom/b_*.c without b_native.c), which
# needs nothing of the engine but its types
TESTS := $(patsubst test/%_test.c,$(OUT)/test/%,$(wildcard test/*_test.c))

test: $(TESTS)
	@for test in $(TESTS); do $$test || exit 1; done

$(OUT)/test/%: test/%_test.c src/doom/%.c src/doom/%.h Makefile
	@mkdir -p $(@D)
	$(CC) -g -Wall -fsanitize=address,undefined -I. -Inative/sdl -Isrc -Isrc/doom $< src/doom/$*.c -lm -o $@

clean:
	rm -rf $(OUT)

.PHONY: all botlib clean native test

-include $(OBJ:.o=.d) $(OUT)/obj/tools/oplrender.d $(NATIVE_OBJ:.o=.d)
