RUST_DIR := ../rust
LIB_DIR := $(RUST_DIR)/target/release

.PHONY: all build-rust test clean

all: build-rust test

## Build the Rust static + shared library (release mode)
build-rust:
	cd $(RUST_DIR) && cargo build --release

## Run Go tests (requires build-rust first)
test: build-rust
	CGO_ENABLED=1 go test -v ./hanzomcp/...

## Run Go tests with race detector
test-race: build-rust
	CGO_ENABLED=1 go test -race -v ./hanzomcp/...

## Quick benchmark
bench: build-rust
	CGO_ENABLED=1 go test -bench=. -benchtime=3s ./hanzomcp/...

## Clean build artifacts
clean:
	cd $(RUST_DIR) && cargo clean
	go clean -cache
