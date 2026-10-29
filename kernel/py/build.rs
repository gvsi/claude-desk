// Lets a plain `cargo build` link the extension module on macOS (maturin adds
// the same flags itself), so `cargo test` still compiles the bindings.
fn main() {
    pyo3_build_config::add_extension_module_link_args();
}
